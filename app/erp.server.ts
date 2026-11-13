// Talks to the ERP / warehouse system over its REST API.
// The ".server" in the file name means this code never reaches the browser.

const ERP_URL = process.env.ERP_URL ?? "http://localhost:4000";
const ERP_API_KEY = process.env.ERP_API_KEY ?? "dev-erp-key";

// An error that knows whether it's worth trying again
export class ErpError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public retryable: boolean,
    public retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ErpError";
  }
}

async function erpFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ERP_URL}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-api-key": ERP_API_KEY,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000), // give up after 10 seconds
    });
  } catch (error) {
    // Network failure or timeout: the ERP may be down, so try again later
    throw new ErpError(`ERP unreachable: ${(error as Error).message}`, null, true);
  }

  if (res.ok) return (await res.json()) as T;

  const body = await res.text();
  const retryAfterSeconds = Number(res.headers.get("retry-after"));
  const retryable = res.status === 429 || res.status >= 500;

  throw new ErpError(
    `ERP ${res.status}: ${body.slice(0, 200)}`,
    res.status,
    retryable,
    retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : null,
  );
}

// ── Types that match the mock ERP's API ──
export type ErpStockLevel = { sku: string; warehouse: string; quantity: number; updatedAt: string };
export type ErpOrderLine = { sku: string; quantity: number };
export type ErpOrder = {
  erpOrderId: string;
  shopifyOrderId: string;
  lines: ErpOrderLine[];
  status: "received" | "shipped";
  trackingNumber: string | null;
  carrier: string | null;
  updatedAt: string;
};

// ── The three calls the sync uses ──
export function getInventory(updatedSince?: string) {
  const query = updatedSince ? `?updatedSince=${encodeURIComponent(updatedSince)}` : "";
  return erpFetch<{ stock: ErpStockLevel[]; serverTime: string }>(`/api/inventory${query}`);
}

export function createOrder(shopifyOrderId: string, lines: ErpOrderLine[]) {
  return erpFetch<{ order: ErpOrder; duplicate: boolean }>("/api/orders", {
    method: "POST",
    body: JSON.stringify({ shopifyOrderId, lines }),
  });
}

export function getShippedOrders(updatedSince?: string) {
  const params = new URLSearchParams({ status: "shipped" });
  if (updatedSince) params.set("updatedSince", updatedSince);
  return erpFetch<{ orders: ErpOrder[]; serverTime: string }>(`/api/orders?${params}`);
}