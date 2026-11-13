// A small, database-backed job queue.
// Every sync task is saved as a row first, so nothing is lost if the ERP or this app goes down.
import prisma from "./db.server";
import { ErpError } from "./erp.server";

export type JobType = "push_order" | "pull_inventory" | "pull_fulfillments";
export type JobHandler = (job: { shop: string; payload: unknown }) => Promise<void>;

const BASE_DELAY_MS = 2_000; // first retry after about 2 seconds
const MAX_DELAY_MS = 5 * 60_000; // never wait more than 5 minutes

// Exponential backoff: 2s, 4s, 8s, 16s… capped at 5 minutes.
// The small random "jitter" stops many failed jobs from all retrying at the same instant.
export function backoffDelay(attempt: number, random: () => number = Math.random) {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  const jitter = exponential * 0.2 * random();
  return Math.round(exponential + jitter);
}

// Add a job. If a job with the same dedupe key already exists, nothing happens.
export async function enqueue(shop: string, type: JobType, payload: unknown, dedupeKey: string) {
  try {
    return await prisma.syncJob.create({
      data: { shop, type, payload: JSON.stringify(payload), dedupeKey },
    });
  } catch (error) {
    // P2002 = unique constraint failed, i.e. this job is already queued
    if ((error as { code?: string }).code === "P2002") return null;
    throw error;
  }
}

// Take the next job that's due and mark it "running".
// The status check in updateMany means two workers can never grab the same job.
async function claimNextJob() {
  const job = await prisma.syncJob.findFirst({
    where: { status: "pending", runAt: { lte: new Date() } },
    orderBy: { runAt: "asc" },
  });
  if (!job) return null;

  const claimed = await prisma.syncJob.updateMany({
    where: { id: job.id, status: "pending" },
    data: { status: "running", attempts: { increment: 1 } },
  });
  return claimed.count === 1 ? { ...job, attempts: job.attempts + 1 } : null;
}

// Run one job. Returns true if there was a job to run.
export async function runNextJob(handlers: Record<JobType, JobHandler>) {
  const job = await claimNextJob();
  if (!job) return false;

  try {
    const handler = handlers[job.type as JobType];
    if (!handler) throw new ErpError(`Unknown job type: ${job.type}`, null, false);

    await handler({ shop: job.shop, payload: JSON.parse(job.payload) });

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "succeeded", lastError: null, finishedAt: new Date() },
    });
    console.log(`✅ ${job.type} succeeded (attempt ${job.attempts})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // ERP errors know if they're worth retrying. Anything else is assumed to be temporary.
    const retryable = error instanceof ErpError ? error.retryable : true;
    const outOfAttempts = job.attempts >= job.maxAttempts;

    if (!retryable || outOfAttempts) {
      await prisma.syncJob.update({
        where: { id: job.id },
        data: { status: "dead", lastError: message, finishedAt: new Date() },
      });
      console.log(`☠️  ${job.type} moved to dead-letter queue: ${message}`);
    } else {
      // Respect the ERP's "Retry-After" if it asked us to wait longer
      const askedFor = error instanceof ErpError ? (error.retryAfterMs ?? 0) : 0;
      const wait = Math.max(askedFor, backoffDelay(job.attempts));

      await prisma.syncJob.update({
        where: { id: job.id },
        data: { status: "pending", lastError: message, runAt: new Date(Date.now() + wait) },
      });
      console.log(
        `↻  ${job.type} failed (attempt ${job.attempts}/${job.maxAttempts}), retrying in ${Math.round(wait / 1000)}s: ${message}`,
      );
    }
  }
  return true;
}

// The dashboard's Retry button: put a dead job back in the queue with a fresh start
export async function retryJob(id: string, shop: string) {
  await prisma.syncJob.updateMany({
    where: { id, shop, status: "dead" },
    data: { status: "pending", attempts: 0, runAt: new Date(), lastError: null, finishedAt: null },
  });
}

// If the app restarted in the middle of a job, that job is stuck as "running". Put it back.
export async function recoverStuckJobs() {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);
  await prisma.syncJob.updateMany({
    where: { status: "running", updatedAt: { lt: fiveMinutesAgo } },
    data: { status: "pending" },
  });
}