// The background worker: runs due jobs every second, and schedules the regular ERP checks.
import prisma from "./db.server";
import {
  enqueue,
  recoverStuckJobs,
  runNextJob,
  type JobHandler,
  type JobType,
} from "./queue.server";
import { pullInventory } from "./inventory.server";
import { pushOrder, type PushOrderPayload } from "./orders.server";

const TICK_MS = 1_000; // look for due jobs every second
const SCHEDULE_MS = 60_000; // check the ERP for changes every minute

// Placeholders: milestone 4 replaces these with the real sync logic
const handlers: Record<JobType, JobHandler> = {
  push_order: async ({ payload }) => pushOrder(payload as PushOrderPayload),
  pull_inventory: async ({ shop }) => pullInventory(shop),
  pull_fulfillments: async ({ shop }) => console.log(`🚚 (placeholder) pull fulfillments for ${shop}`),
};

// Add this minute's recurring jobs for every store that has installed the app.
// The dedupe key includes the minute, so each check is queued only once per minute.
async function scheduleRecurringJobs() {
  const stores = await prisma.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  const minute = new Date().toISOString().slice(0, 16); // e.g. "2026-11-13T19:30"

  for (const { shop } of stores) {
    await enqueue(shop, "pull_inventory", {}, `pull_inventory:${minute}`);
    await enqueue(shop, "pull_fulfillments", {}, `pull_fulfillments:${minute}`);
  }
}

type WorkerGlobals = typeof globalThis & { __mapleSyncTimers?: ReturnType<typeof setInterval>[] };

export function startWorker() {
  // In development the code reloads when you save. Stop the old worker first,
  // so there's only ever one running and it always uses your latest code.
  const g = globalThis as WorkerGlobals;
  g.__mapleSyncTimers?.forEach(clearInterval);

  let busy = false;
  const jobTimer = setInterval(async () => {
    if (busy) return; // previous run hasn't finished yet
    busy = true;
    try {
      while (await runNextJob(handlers)) {
        // keep going until there are no more due jobs
      }
    } catch (error) {
      console.error("Worker error:", error);
    } finally {
      busy = false;
    }
  }, TICK_MS);

  const scheduleTimer = setInterval(() => {
    scheduleRecurringJobs().catch((error) => console.error("Scheduler error:", error));
  }, SCHEDULE_MS);

  g.__mapleSyncTimers = [jobTimer, scheduleTimer];

  recoverStuckJobs().catch((error) => console.error("Recovery error:", error));
  scheduleRecurringJobs().catch((error) => console.error("Scheduler error:", error));
  console.log("👷 Sync worker started");
}