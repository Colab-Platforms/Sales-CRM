// READ-ONLY report: CRM-created PREPAID orders (verified payment) whose Shiprocket order, imported through the Shopify channel, is COD.
//   npm run shiprocket:payment-mismatch -- --since 2026-10-20 --until 2026-11-14
// Reads the CRM database and calls only Shiprocket GET /orders. It writes nothing, cancels nothing, creates nothing and prints no customer data: order numbers, amounts, status and AWB only.
// Operators run it with server access (Admin / Manager level). Orders that are already shipped or delivered must NOT be changed in Shiprocket: they go to the support / COD-reconciliation workflow.
import "dotenv/config";
import { prisma } from "../lib/prisma.js";
import { ShiprocketClient } from "../modules/shiprocket/shiprocket.client.js";
import { loadShiprocketConfig } from "../modules/shiprocket/shiprocket.config.js";
import { chunkWindow } from "../modules/shiprocket/shiprocket.backfill.js";
import { classifyPaymentMismatch } from "../modules/shiprocket/shiprocket.payment-mismatch.js";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const since = arg("since", day(-14));
const until = arg("until", day(0));
const key = (s: unknown) => String(s ?? "").replace(/^#/, "").trim().toLowerCase();

const config = loadShiprocketConfig(process.env);
if (!config) throw new Error("Shiprocket is not configured");
const client = new ShiprocketClient(config as never) as unknown as { call(method: string, path: string): Promise<{ data?: Record<string, unknown>[]; meta?: { pagination?: { total_pages?: number } } }> };

const windows = chunkWindow(since, until);
const byChannelId = new Map<string, Record<string, unknown>[]>();
for (const w of windows) {
  for (let page = 1; page < 500; page++) {
    let json: Awaited<ReturnType<typeof client.call>> | undefined;
    for (let attempt = 1; attempt <= 4 && !json; attempt++) {
      try {
        json = await client.call("GET", `/orders?page=${page}&per_page=100&from=${w.from}&to=${w.to}&sort_by=id&sort=ASC`);
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((r) => setTimeout(r, 2000 * attempt)); // transient provider timeout: read-only, safe to repeat
      }
    }
    if (!json) break;
    const list = Array.isArray(json.data) ? json.data : [];
    for (const o of list) byChannelId.set(key(o.channel_order_id), [...(byChannelId.get(key(o.channel_order_id)) ?? []), o]);
    if (page >= (json.meta?.pagination?.total_pages ?? 1) || list.length === 0) break;
  }
}

const orders = await prisma.order.findMany({
  where: { externalSource: "SHOPIFY", createdAt: { gte: new Date(`${since}T00:00:00Z`) } },
  select: { orderNumber: true, externalNumber: true, status: true, totalAmount: true, createdAt: true, metadata: true, payments: { select: { status: true, provider: true } } },
});

const rows: Record<string, unknown>[] = [];
const cancelledZero: string[] = [];
let checked = 0;
for (const o of orders) {
  const meta = (o.metadata ?? {}) as Record<string, any>;
  const paid = o.payments.some((p) => p.status === "SUCCESS");
  const sr = (byChannelId.get(key(o.externalNumber)) ?? []).find((r) => String(r.base_channel_code) === "SH" || /shopify/i.test(String(r.channel_name)));
  if (!sr) continue;
  checked += 1;
  const kind = classifyPaymentMismatch({ crmMode: meta.paymentMode, crmPaid: paid, crmStatus: o.status, srMode: String(sr.payment_method), srTotal: sr.total as string, srStatus: String(sr.status) });
  if (!kind) continue;
  if (kind === "CANCELLED_ZERO_TOTAL") {
    cancelledZero.push(`${o.orderNumber} / ${o.externalNumber}`);
    continue;
  }
  const shipment = Array.isArray(sr.shipments) ? (sr.shipments[0] as Record<string, unknown> | undefined) : undefined;
  rows.push({
    kind,
    crmOrder: o.orderNumber,
    shopifyOrder: o.externalNumber,
    crmPaymentStatus: paid ? "SUCCESS" : "NOT PAID",
    crmPaymentProvider: o.payments.map((p) => p.provider).join("+"),
    shopifyFinancialStatus: meta.shopifyPaymentSync?.financialStatus ?? "(see Shopify)",
    shiprocketPaymentMode: String(sr.payment_method).toUpperCase(),
    codAmount: sr.total,
    awb: shipment?.awb ?? shipment?.awb_code ?? null,
    shipmentStatus: sr.status,
    action: kind === "COD_AS_PREPAID" ? "CRM COD order shown prepaid - review in Shopify and with Shiprocket support; do not change the shipment" : /deliver/i.test(String(sr.status)) ? "DELIVERED - support / COD reconciliation only, do not change the shipment" : /rto|return/i.test(String(sr.status)) ? "RTO - support review" : "NOT delivered - ask Shiprocket support to correct the payment mode; do not cancel or recreate",
  });
}
console.log(`Window ${since}..${until}: CRM orders found in Shiprocket's Shopify channel: ${checked}; payment-mode mismatches: ${rows.length}; cancelled COD orders shown prepaid at 0.00 (expected, not an error): ${cancelledZero.length}`);
console.table(rows);
if (cancelledZero.length > 0) console.log("Cancelled zero-total COD orders (Shiprocket renders a cancelled 0.00 order as Prepaid):", cancelledZero.join(", "));
await prisma.$disconnect();
