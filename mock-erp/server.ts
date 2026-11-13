import express, { type NextFunction, type Request, type Response } from "express";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ── Settings ─────────────────────────────────────────────
const PORT = 4000;
const API_KEY = process.env.ERP_API_KEY ?? "dev-erp-key";
// 0 = never fail, 0.3 = about 30% of API calls fail (for testing retries)
const FAILURE_RATE = Number(process.env.ERP_FAILURE_RATE ?? 0);
const DATA_FILE = new URL("./data.json", import.meta.url);

// ── Data model ───────────────────────────────────────────
type StockLevel = { sku: string; warehouse: string; quantity: number; updatedAt: string };
type OrderLine = { sku: string; quantity: number };
type ErpOrder = {
  erpOrderId: string;
  shopifyOrderId: string; // used to ignore duplicates (idempotency)
  lines: OrderLine[];
  status: "received" | "shipped";
  trackingNumber: string | null;
  carrier: string | null;
  createdAt: string;
  updatedAt: string;
};
type Db = { stock: StockLevel[]; orders: ErpOrder[] };

const SKUS = [
  "ML-SHEET-Q", "ML-SHEET-K", "ML-DUVET-OAT", "ML-DUVET-SAGE",
  "ML-TOWEL-WHT", "ML-TOWEL-CHR", "ML-DO-CER", "ML-DO-MAR",
  "ML-MIX-BLK", "ML-KNIFE-8", "ML-DIN-WHT", "ML-WINE-4",
  "ML-THROW-GRY", "ML-LAMP-CER", "ML-SWADDLE-3",
];
const WAREHOUSES = ["TOR-DC", "MTL-DC"]; // Toronto and Montreal distribution centres

function seed(): Db {
  const now = new Date().toISOString();
  return {
    stock: SKUS.flatMap((sku) =>
      WAREHOUSES.map((warehouse) => ({ sku, warehouse, quantity: 25, updatedAt: now })),
    ),
    orders: [],
  };
}

// The "database" is a JSON file, so you can open it and see exactly what the ERP holds
function load(): Db {
  if (!existsSync(DATA_FILE)) save(seed());
  return JSON.parse(readFileSync(DATA_FILE, "utf8")) as Db;
}
function save(db: Db) {
  writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

// ── App ──────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Real ERPs are slow and unreliable sometimes. This simulates that for /api calls.
async function chaos(_req: Request, res: Response, next: NextFunction) {
  await new Promise((r) => setTimeout(r, 100 + Math.random() * 400)); // 100–500ms delay
  if (Math.random() < FAILURE_RATE) {
    if (Math.random() < 0.5) {
      res.setHeader("Retry-After", "2");
      return res.status(429).json({ error: "Rate limit exceeded" });
    }
    return res.status(503).json({ error: "ERP temporarily unavailable" });
  }
  next();
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (req.header("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
}

const api = express.Router();
api.use(requireApiKey, chaos);

// Stock levels, optionally only those changed since a time (?updatedSince=ISO date)
api.get("/inventory", (req, res) => {
  const since = typeof req.query.updatedSince === "string" ? req.query.updatedSince : null;
  const stock = load().stock.filter((s) => !since || s.updatedAt > since);
  res.json({ stock, serverTime: new Date().toISOString() });
});

// Receive an order from Shopify. Sending the same order twice returns the original.
api.post("/orders", (req, res) => {
  const { shopifyOrderId, lines } = req.body as { shopifyOrderId?: string; lines?: OrderLine[] };
  if (!shopifyOrderId || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "shopifyOrderId and lines are required" });
  }

  const db = load();
  const existing = db.orders.find((o) => o.shopifyOrderId === shopifyOrderId);
  if (existing) return res.status(200).json({ order: existing, duplicate: true });

  const now = new Date().toISOString();
  const order: ErpOrder = {
    erpOrderId: `ERP-${randomUUID().slice(0, 8).toUpperCase()}`,
    shopifyOrderId,
    lines,
    status: "received",
    trackingNumber: null,
    carrier: null,
    createdAt: now,
    updatedAt: now,
  };

  // Reserve stock from the Toronto warehouse
  for (const line of lines) {
    const level = db.stock.find((s) => s.sku === line.sku && s.warehouse === "TOR-DC");
    if (level) {
      level.quantity = Math.max(0, level.quantity - line.quantity);
      level.updatedAt = now;
    }
  }

  db.orders.push(order);
  save(db);
  res.status(201).json({ order, duplicate: false });
});

// Orders, optionally filtered by status and change time
api.get("/orders", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const since = typeof req.query.updatedSince === "string" ? req.query.updatedSince : null;
  const orders = load().orders.filter(
    (o) => (!status || o.status === status) && (!since || o.updatedAt > since),
  );
  res.json({ orders, serverTime: new Date().toISOString() });
});

app.use("/api", api);

// ── Warehouse console (a simple page to play warehouse worker) ──
app.get("/", (_req, res) => {
  const db = load();
  const stockRows = SKUS.map((sku) => {
    const cells = WAREHOUSES.map((w) => {
      const q = db.stock.find((s) => s.sku === sku && s.warehouse === w)?.quantity ?? 0;
      return `<td>${q}
        <form method="post" action="/console/receive">
          <input type="hidden" name="sku" value="${sku}">
          <input type="hidden" name="warehouse" value="${w}">
          <button>+10</button>
        </form></td>`;
    }).join("");
    return `<tr><td>${sku}</td>${cells}</tr>`;
  }).join("");

  const orderRows = db.orders
    .slice()
    .reverse()
    .map(
      (o) => `<tr>
        <td>${o.erpOrderId}</td>
        <td>${o.shopifyOrderId.split("/").pop()}</td>
        <td>${o.lines.map((l) => `${l.quantity} × ${l.sku}`).join("<br>")}</td>
        <td>${o.status}${o.trackingNumber ? `<br><small>${o.carrier} ${o.trackingNumber}</small>` : ""}</td>
        <td>${
          o.status === "received"
            ? `<form method="post" action="/console/ship">
                 <input type="hidden" name="erpOrderId" value="${o.erpOrderId}">
                 <button>Ship</button>
               </form>`
            : "✓"
        }</td>
      </tr>`,
    )
    .join("");

  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Mock ERP · Warehouse console</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 32px; color: #13254a; background: #f7f3ed; }
  h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 32px; }
  table { border-collapse: collapse; background: #fff; }
  th, td { border: 1px solid #e4ddd2; padding: 8px 12px; text-align: left; vertical-align: top; }
  form { display: inline; margin-left: 8px; }
  button { cursor: pointer; padding: 4px 10px; border-radius: 6px; border: 1px solid #13254a; background: #fff; }
  .note { color: #5f6470; font-size: 14px; }
</style></head><body>
  <h1>Mock ERP · Warehouse console</h1>
  <p class="note">Failure rate: ${Math.round(FAILURE_RATE * 100)}% · Changes here sync to Shopify on the next sync run.</p>
  <h2>Stock levels</h2>
  <table><tr><th>SKU</th>${WAREHOUSES.map((w) => `<th>${w}</th>`).join("")}</tr>${stockRows}</table>
  <h2>Orders (${db.orders.length})</h2>
  ${db.orders.length ? `<table><tr><th>ERP order</th><th>Shopify order</th><th>Items</th><th>Status</th><th></th></tr>${orderRows}</table>` : `<p class="note">No orders yet.</p>`}
</body></html>`);
});

app.post("/console/receive", (req, res) => {
  const db = load();
  const level = db.stock.find((s) => s.sku === req.body.sku && s.warehouse === req.body.warehouse);
  if (level) {
    level.quantity += 10;
    level.updatedAt = new Date().toISOString();
    save(db);
  }
  res.redirect("/");
});

app.post("/console/ship", (req, res) => {
  const db = load();
  const order = db.orders.find((o) => o.erpOrderId === req.body.erpOrderId);
  if (order && order.status === "received") {
    order.status = "shipped";
    order.carrier = "Canada Post";
    order.trackingNumber = `CP${Math.floor(1e11 + Math.random() * 9e11)}CA`;
    order.updatedAt = new Date().toISOString();
    save(db);
  }
  res.redirect("/");
});

app.listen(PORT, () => {
  console.log(`🏭 Mock ERP running at http://localhost:${PORT} (failure rate ${FAILURE_RATE * 100}%)`);
});