// Checks that ERP errors are sorted correctly into "retry" and "give up"
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErpError, getInventory } from "../app/erp.server";

// Pretend the ERP answered with this status and body (no real network call)
function erpRespondsWith(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("ERP client", () => {
  it("returns the data when the ERP answers normally", async () => {
    erpRespondsWith(200, { stock: [], serverTime: "2026-11-18T00:00:00.000Z" });
    await expect(getInventory()).resolves.toEqual({ stock: [], serverTime: "2026-11-18T00:00:00.000Z" });
  });

  it("treats 503 (ERP down) as retryable", async () => {
    erpRespondsWith(503, { error: "ERP temporarily unavailable" });
    await expect(getInventory()).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it("treats 429 (rate limited) as retryable and respects Retry-After", async () => {
    erpRespondsWith(429, { error: "Rate limit exceeded" }, { "Retry-After": "2" });
    await expect(getInventory()).rejects.toMatchObject({
      status: 429,
      retryable: true,
      retryAfterMs: 2_000,
    });
  });

  it("treats 400 (bad data) as permanent, so it goes straight to the dead-letter queue", async () => {
    erpRespondsWith(400, { error: "shopifyOrderId and lines are required" });
    await expect(getInventory()).rejects.toMatchObject({ status: 400, retryable: false });
  });

  it("treats a network failure as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const error = await getInventory().catch((e) => e);
    expect(error).toBeInstanceOf(ErpError);
    expect(error).toMatchObject({ status: null, retryable: true });
  });
});