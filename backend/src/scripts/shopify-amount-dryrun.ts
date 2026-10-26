import "dotenv/config";
import { writeFileSync } from "node:fs";
import { prisma } from "../lib/prisma.js";
import { ShopifyClient } from "../modules/shopify/shopify.client.js";
import { loadShopifyConfig } from "../modules/shopify/shopify.config.js";
import { classifyOrder } from "../modules/shopify/shopify.order-audit.js";
import { loadCrmAuditOrders, loadShopifyAuditOrders } from "../modules/shopify/shopify.order-audit.load.js";
import OrderAmountService from "../modules/orders/orders.amount.service.js";

// READ-ONLY dry run for "Review & Correct Amount": for every CRM order whose total differs from Shopify, re-read the CRM, Shopify AND Shiprocket and say what the amount action would do. Nothing is edited anywhere.
//   SAFE_FOR_CORRECTION   a supported correction (the missing COD shipping line) and every gate passes - an Admin / Manager could apply it from the order page after confirming
//   REQUIRES_APPROVAL     a supported correction, but the only blocker is the courier amount: someone must first align the Shiprocket order (or decide to keep the lower amount)
//   BLOCKED               anything else: cancelled / fulfilled / shipped / paid / refunded, a discount / tax / line / price difference, an unverifiable courier - manual review
// Usage: npm run shopify:amount-dryrun -- --out <file.json>
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const crm = await loadCrmAuditOrders(prisma as never);
const shop = await loadShopifyAuditOrders(new ShopifyClient(loadShopifyConfig(process.env)), crm.map((o) => o.externalId));
const mismatched = crm.filter((c) => { const s = shop.get(c.externalId); return s ? Boolean(classifyOrder(c, s).money) : false; });
console.log(`Orders whose total differs between the CRM and Shopify: ${mismatched.length}`);

const service = new OrderAmountService(prisma as never);
const admin = { id: "dry-run", username: "dry-run", role: "ADMIN" } as never;
type Bucket = "SAFE_FOR_CORRECTION" | "REQUIRES_APPROVAL" | "BLOCKED";
const rows: { order: string | null; crmOrderId: string; kind: string; difference: string; bucket: Bucket; blockers: string[]; shiprocketTotal: string | null; proposal: string | null }[] = [];
for (const c of mismatched) {
  const s = shop.get(c.externalId)!;
  const r = classifyOrder(c, s);
  const p = await service.preview(admin, c.id);
  const failed = p.gates.filter((g) => !g.ok);
  const bucket: Bucket = !p.proposal ? "BLOCKED" : failed.length === 0 ? "SAFE_FOR_CORRECTION" : failed.every((g) => g.key === "courier" && /not \d|, not /.test(g.detail) && !/could not be verified|already has a courier|not COD|match this order/.test(g.detail)) ? "REQUIRES_APPROVAL" : "BLOCKED";
  rows.push({ order: s.name, crmOrderId: c.id, kind: r.money!.kind, difference: (r.differenceCents / 100).toFixed(2), bucket, blockers: p.proposal ? failed.map((g) => `${g.label}: ${g.detail}`) : [p.manualReason ?? "no supported correction"], shiprocketTotal: p.courier?.total ?? null, proposal: p.proposal ? `${p.proposal.before.total} -> ${p.proposal.after.total}` : null });
}
for (const b of ["SAFE_FOR_CORRECTION", "REQUIRES_APPROVAL", "BLOCKED"] as Bucket[]) {
  const list = rows.filter((x) => x.bucket === b);
  console.log(`\n${b}: ${list.length}`);
  for (const x of list) console.log(`  ${x.order}  ${x.kind}  diff ${x.difference}  shiprocket ${x.shiprocketTotal ?? "-"}  ${x.proposal ?? ""}  ${x.blockers.map((t) => t.slice(0, 110)).join(" | ")}`);
}
if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rows }, null, 1));
await prisma.$disconnect();
