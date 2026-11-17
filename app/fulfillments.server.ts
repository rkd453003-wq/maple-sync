// Fulfillment sync: orders shipped in the ERP → marked fulfilled in Shopify with tracking.
import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";
import { getShippedOrders } from "./erp.server";
import { gql } from "./inventory.server";

// Shopify fulfillment orders in these states still have items waiting to ship
const FULFILLABLE = ["OPEN", "IN_PROGRESS"];

export async function pullFulfillments(shop: string) {
  const { admin } = await unauthenticated.admin(shop);

  const cursor = await prisma.syncCursor.findUnique({
    where: { shop_name: { shop, name: "fulfillments" } },
  });
  const { orders, serverTime } = await getShippedOrders(cursor?.value);

  for (const erpOrder of orders) {
    // Find what's still waiting to ship on this order
    const data = await gql<{
      order: { name: string; fulfillmentOrders: { nodes: { id: string; status: string }[] } } | null;
    }>(
      admin,
      `#graphql
      query OpenFulfillments($id: ID!) {
        order(id: $id) {
          name
          fulfillmentOrders(first: 10) { nodes { id status } }
        }
      }`,
      { id: erpOrder.shopifyOrderId },
    );

    if (!data.order) {
      console.warn(`⚠️  ${erpOrder.erpOrderId}: Shopify order not found, skipped`);
      continue;
    }

    const open = data.order.fulfillmentOrders.nodes.filter((fo) => FULFILLABLE.includes(fo.status));
    if (open.length === 0) {
      // Already fulfilled, e.g. by an earlier attempt, so there's nothing to do
      continue;
    }

    const result = await gql<{
      fulfillmentCreate: { userErrors: { field: string[]; message: string }[] };
    }>(
      admin,
      `#graphql
      mutation Ship($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          userErrors { field message }
        }
      }`,
      {
        fulfillment: {
          // Leaving out the line items fulfills everything still open on each fulfillment order
          lineItemsByFulfillmentOrder: open.map((fo) => ({ fulfillmentOrderId: fo.id })),
          trackingInfo: { company: erpOrder.carrier, number: erpOrder.trackingNumber },
          notifyCustomer: false, // test store: don't send shipping emails
        },
      },
    );

    const errors = result.fulfillmentCreate.userErrors;
    if (errors.length > 0) {
      throw new Error(
        `Couldn't fulfill ${data.order.name}: ${errors.map((e) => e.message).join("; ")}`,
      );
    }
    console.log(
      `🚚 Fulfilled ${data.order.name} (${erpOrder.carrier} ${erpOrder.trackingNumber})`,
    );
  }

  // Move the cursor forward only after every shipped order was handled
  await prisma.syncCursor.upsert({
    where: { shop_name: { shop, name: "fulfillments" } },
    create: { shop, name: "fulfillments", value: serverTime },
    update: { value: serverTime },
  });
}