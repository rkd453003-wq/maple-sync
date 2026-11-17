// Sends a paid Shopify order to the ERP so the warehouse can pick and ship it.
import { createOrder, type ErpOrderLine } from "./erp.server";

export type PushOrderPayload = { shopifyOrderId: string; name: string; lines: ErpOrderLine[] };

export async function pushOrder(payload: PushOrderPayload) {
  // The ERP also ignores duplicates, so a retry after a timeout can't double-ship
  const { order, duplicate } = await createOrder(payload.shopifyOrderId, payload.lines);
  console.log(
    duplicate
      ? `↺ ${payload.name} was already in the ERP as ${order.erpOrderId}`
      : `📤 Sent ${payload.name} to the ERP as ${order.erpOrderId}`,
  );
}