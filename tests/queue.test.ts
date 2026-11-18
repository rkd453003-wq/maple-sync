// Checks the retry timing: 2s, 4s, 8s, 16s… never more than 5 minutes
import { describe, expect, it } from "vitest";
import { backoffDelay } from "../app/queue.server";

const noJitter = () => 0; // removes the randomness so results are predictable

describe("backoffDelay", () => {
  it("doubles the wait after each failed attempt", () => {
    expect(backoffDelay(1, noJitter)).toBe(2_000);
    expect(backoffDelay(2, noJitter)).toBe(4_000);
    expect(backoffDelay(3, noJitter)).toBe(8_000);
    expect(backoffDelay(4, noJitter)).toBe(16_000);
  });

  it("never waits longer than 5 minutes", () => {
    expect(backoffDelay(20, noJitter)).toBe(300_000);
  });

  it("adds up to 20% random jitter so retries don't all fire at once", () => {
    expect(backoffDelay(1, () => 1)).toBe(2_400);
  });
});