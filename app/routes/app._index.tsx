// Sync dashboard: the health of the Shopify ↔ ERP integration at a glance.
import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { enqueue, retryJob } from "../queue.server";

const TYPE_LABELS: Record<string, string> = {
  push_order: "Order → ERP",
  pull_inventory: "Inventory ← ERP",
  pull_fulfillments: "Fulfillment ← ERP",
};

const STATUS_TONES: Record<string, "success" | "critical" | "warning" | "info"> = {
  succeeded: "success",
  dead: "critical",
  pending: "warning",
  running: "info",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Four questions, asked of the database at the same time
  const [counts, dead, recent, lastSuccess] = await Promise.all([
    prisma.syncJob.groupBy({
      by: ["status"],
      where: { shop, updatedAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.syncJob.findMany({
      where: { shop, status: "dead" },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
    prisma.syncJob.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      take: 25,
    }),
    prisma.syncJob.groupBy({
      by: ["type"],
      where: { shop, status: "succeeded" },
      _max: { finishedAt: true },
    }),
  ]);

  const count = (status: string) => counts.find((c) => c.status === status)?._count._all ?? 0;

  return {
    stats: {
      succeeded: count("succeeded"),
      retrying: count("pending") + count("running"),
      dead: count("dead"),
    },
    health: Object.keys(TYPE_LABELS).map((type) => ({
      type,
      lastSuccess: lastSuccess.find((l) => l.type === type)?._max.finishedAt ?? null,
    })),
    dead,
    recent,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "retry") {
    await retryJob(String(form.get("id")), shop);
  }

  if (intent === "sync_now") {
    // A unique dedupe key, so a manual sync is never mistaken for a duplicate
    const key = `manual:${Date.now()}`;
    await enqueue(shop, "pull_inventory", {}, `pull_inventory:${key}`);
    await enqueue(shop, "pull_fulfillments", {}, `pull_fulfillments:${key}`);
  }

  return { ok: true };
};

// "3 min ago", "just now"…
function timeAgo(value: Date | string | null) {
  if (!value) return "Never";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} sec ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

// A readable name for a job, e.g. "Order → ERP · #1003"
function describe(job: { type: string; payload: string }) {
  const label = TYPE_LABELS[job.type] ?? job.type;
  if (job.type === "push_order") {
    try {
      return `${label} · ${JSON.parse(job.payload).name}`;
    } catch {
      return label;
    }
  }
  return label;
}

export default function SyncDashboard() {
  const { stats, health, dead, recent } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const busy = navigation.state !== "idle";

  // Refresh the data every 5 seconds so the dashboard is live
  useEffect(() => {
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 5_000);
    return () => clearInterval(timer);
  }, [revalidator]);

  return (
    <s-page heading="Sync dashboard">
      <s-section heading="Last 24 hours">
        <s-stack direction="inline" gap="base">
          <s-box padding="base" border="base" borderRadius="base">
            <s-text>Succeeded</s-text>
            <s-heading>{stats.succeeded}</s-heading>
          </s-box>
          <s-box padding="base" border="base" borderRadius="base">
            <s-text>Waiting to retry</s-text>
            <s-heading>{stats.retrying}</s-heading>
          </s-box>
          <s-box padding="base" border="base" borderRadius="base">
            <s-text>Dead (needs attention)</s-text>
            <s-heading>{stats.dead}</s-heading>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Flow health">
        <s-stack gap="base">
          <s-table>
            <s-table-header-row>
              <s-table-header>Flow</s-table-header>
              <s-table-header>Last successful sync</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {health.map((h) => (
                <s-table-row key={h.type}>
                  <s-table-cell>{TYPE_LABELS[h.type]}</s-table-cell>
                  <s-table-cell>{timeAgo(h.lastSuccess)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <Form method="post">
            <input type="hidden" name="intent" value="sync_now" />
            <s-button type="submit" variant="primary">
              {busy ? "Queuing…" : "Sync now"}
            </s-button>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading={`Dead-letter queue (${dead.length})`}>
        {dead.length === 0 ? (
          <s-paragraph>Nothing here. Every job has either succeeded or is still retrying.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Job</s-table-header>
              <s-table-header>Attempts</s-table-header>
              <s-table-header>Error</s-table-header>
              <s-table-header>Failed</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {dead.map((job) => (
                <s-table-row key={job.id}>
                  <s-table-cell>{describe(job)}</s-table-cell>
                  <s-table-cell>{job.attempts}</s-table-cell>
                  <s-table-cell>{job.lastError?.slice(0, 120)}</s-table-cell>
                  <s-table-cell>{timeAgo(job.updatedAt)}</s-table-cell>
                  <s-table-cell>
                    <Form method="post">
                      <input type="hidden" name="intent" value="retry" />
                      <input type="hidden" name="id" value={job.id} />
                      <s-button type="submit">Retry</s-button>
                    </Form>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Recent activity">
        <s-table>
          <s-table-header-row>
            <s-table-header>Job</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Attempts</s-table-header>
            <s-table-header>Last error</s-table-header>
            <s-table-header>Updated</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {recent.map((job) => (
              <s-table-row key={job.id}>
                <s-table-cell>{describe(job)}</s-table-cell>
                <s-table-cell>
                  <s-badge tone={STATUS_TONES[job.status] ?? "info"}>{job.status}</s-badge>
                </s-table-cell>
                <s-table-cell>
                  {job.attempts}/{job.maxAttempts}
                </s-table-cell>
                <s-table-cell>{job.lastError ? job.lastError.slice(0, 80) : "—"}</s-table-cell>
                <s-table-cell>{timeAgo(job.updatedAt)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}