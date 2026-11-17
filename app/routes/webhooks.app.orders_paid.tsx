// Shopify calls this when an order is paid. It only queues the work,
// so it can answer Shopify instantly even if the ERP is slow or down.
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueue } from "../queue.server";

type OrderPayload = {
  admin_graphql_api_id: string;
  name: string; // e.g. "#1004"
  line_items: { sku: string | null; quantity: number }[];
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // Verifies Shopify's HMAC signature, so fake orders are rejected
  const { shop, topic, payload } = await authenticate.webhook(request);
  const order = payload as OrderPayload;

  // Only items with a SKU can be picked in the warehouse
  const lines = order.line_items
    .filter((line) => line.sku)
    .map((line) => ({ sku: line.sku as string, quantity: line.quantity }));
  if (lines.length === 0) return new Response();

  // The dedupe key is the order ID, so a duplicate webhook can't create a second job
  const job = await enqueue(
    shop,
    "push_order",
    { shopifyOrderId: order.admin_graphql_api_id, name: order.name, lines },
    `push_order:${order.admin_graphql_api_id}`,
  );

  console.log(
    job
      ? `🧾 ${topic}: queued ${order.name} for the ERP`
      : `↺ ${order.name} already queued, duplicate webhook ignored`,
  );
  return new Response();
};