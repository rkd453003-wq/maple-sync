// Inventory sync: ERP stock levels → Shopify, per warehouse/location.
import { randomUUID } from "node:crypto";
import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";
import { getInventory } from "./erp.server";

// Which Shopify location each ERP warehouse feeds
const WAREHOUSE_LOCATIONS: Record<string, string> = {
  "TOR-DC": "Shop location",
  "MTL-DC": "My Custom Location",
};

export type Admin = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

// Small helper: run a GraphQL query and fail loudly if Shopify returns errors
export async function gql<T>(admin: Admin, query: string, variables: Record<string, unknown> = {}) {
  const res = await admin.graphql(query, { variables });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!json.data) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// Turn warehouse codes into Shopify location IDs
async function getLocationIds(admin: Admin) {
  const data = await gql<{ locations: { nodes: { id: string; name: string }[] } }>(
    admin,
    `#graphql
    query Locations { locations(first: 50) { nodes { id name } } }`,
  );
  const byName = new Map(data.locations.nodes.map((l) => [l.name, l.id]));
  const ids: Record<string, string> = {};
  for (const [warehouse, name] of Object.entries(WAREHOUSE_LOCATIONS)) {
    const id = byName.get(name);
    if (id) ids[warehouse] = id;
    else console.warn(`⚠️  No Shopify location named "${name}" for ${warehouse}`);
  }
  return ids;
}

// SKU → the Shopify inventory item that holds its stock
async function findInventoryItemId(admin: Admin, sku: string) {
  const data = await gql<{ productVariants: { nodes: { inventoryItem: { id: string } }[] } }>(
    admin,
    `#graphql
    query FindBySku($q: String!) {
      productVariants(first: 1, query: $q) { nodes { inventoryItem { id } } }
    }`,
    { q: `sku:${sku}` },
  );
  return data.productVariants.nodes[0]?.inventoryItem.id ?? null;
}

export async function pullInventory(shop: string) {
  const { admin } = await unauthenticated.admin(shop);

  // Only ask the ERP for what changed since the last successful sync
  const cursor = await prisma.syncCursor.findUnique({
    where: { shop_name: { shop, name: "inventory" } },
  });
  const firstSync = !cursor;
  const { stock, serverTime } = await getInventory(cursor?.value);

  const quantities: { inventoryItemId: string; locationId: string; quantity: number }[] = [];

  if (stock.length > 0) {
    const locations = await getLocationIds(admin);
    const itemIds = new Map<string, string | null>(); // look up each SKU once

    for (const level of stock) {
      const locationId = locations[level.warehouse];
      if (!locationId) continue;

      if (!itemIds.has(level.sku)) itemIds.set(level.sku, await findInventoryItemId(admin, level.sku));
      const inventoryItemId = itemIds.get(level.sku);
      if (!inventoryItemId) {
        console.warn(`⚠️  SKU ${level.sku} isn't in Shopify, skipped`);
        continue;
      }
      quantities.push({ inventoryItemId, locationId, quantity: level.quantity });
    }

     // First sync only: make sure every item is stocked at its location.
    // The key is built from the item + location, so repeating this is harmless.
    if (firstSync) {
      for (const q of quantities) {
        await gql(
          admin,
          `#graphql
          mutation Activate($item: ID!, $location: ID!, $key: String!) {
            inventoryActivate(inventoryItemId: $item, locationId: $location) @idempotent(key: $key) {
              userErrors { message }
            }
          }`,
          { item: q.inventoryItemId, location: q.locationId, key: `activate:${q.inventoryItemId}:${q.locationId}` },
        );
      }
    }

    if (quantities.length > 0) {
      // One API call sets every stock level at once.
      // changeFromQuantity: null = "set it, don't compare first" (the ERP is the source of truth).
      const data = await gql<{
        inventorySetQuantities: { userErrors: { field: string[]; message: string }[] };
      }>(
        admin,
        `#graphql
        mutation SetStock($input: InventorySetQuantitiesInput!, $key: String!) {
          inventorySetQuantities(input: $input) @idempotent(key: $key) {
            userErrors { field message }
          }
        }`,
        {
          input: {
            name: "available",
            reason: "correction",
            quantities: quantities.map((q) => ({ ...q, changeFromQuantity: null })),
          },
          key: randomUUID(),
        },
      );
      const errors = data.inventorySetQuantities.userErrors;
      if (errors.length > 0) {
        throw new Error(`Shopify rejected the stock update: ${errors.map((e) => e.message).join("; ")}`);
      }
    }
  }

  // Move the cursor forward only after everything succeeded
  await prisma.syncCursor.upsert({
    where: { shop_name: { shop, name: "inventory" } },
    create: { shop, name: "inventory", value: serverTime },
    update: { value: serverTime },
  });

  if (quantities.length > 0) console.log(`📦 Synced ${quantities.length} stock levels from the ERP`);
}