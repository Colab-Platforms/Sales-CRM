// Reconciliation of Shopify orders that were created from the CRM WITHOUT (or with an incomplete) shipping address - Shopify drops an address whose last name is blank (see shopify.order-mapping.ts, mapAddress).
//
//   1. DRY RUN (the default - reads only: no write to the CRM or to Shopify). Writes a JSON report:
//        npm run shopify:repair-addresses -- [--since=2026-08-01] [--limit=200] [--report=path.json]
//   2. APPLY (writes to Shopify through the existing audited re-sync, ONLY for the orders the dry run flags):
//        npm run shopify:repair-addresses -- --apply --confirm=REPAIR-SHOPIFY-ADDRESSES --admin=<admin username> [--since=...] [--limit=...] [--report=path.json]
//   TARGETED (exact orders from a dry-run report; recommended for the canary): add --orders=CRM-AAA,CRM-BBB,CRM-CCC (CRM order numbers) - only those orders are examined, whatever their age.
//   BATCH CAP: --max-repairs=N stops after N orders have actually been written (applies to --apply). Without --orders, --limit selects the newest N orders in range, NOT the newest N that need a repair.
//
// What it guarantees
//  - Matching: an order is touched only when the Shopify id the CRM stored for it points at an order that carries THIS CRM order number (sourceIdentifier) and name, and is not cancelled. Anything else is skipped as
//    "identifier mismatch". Names, phone numbers and addresses are never used to match.
//  - Source of truth: the CRM address is used only when it is complete (line 1, city, PIN code and a recipient name); nothing is invented.
//  - Only what is missing is written: the repair sends the shipping address with every NON-blank value Shopify already has kept as it is (a corrected or valid field is never overwritten). Fields Shopify has that differ
//    from the CRM are listed in the report for a person to review and are NOT changed. Shipping and billing stay distinct: Shopify's orderUpdate cannot set a billing address, so a missing billing address is only
//    reported. Payment status, items, totals, tags and every other field are not touched, and no order is created.
//  - Idempotent and re-runnable: an order that is already complete is "ok" and is not written again; a second run changes nothing. Each order is retried (up to 3 attempts, with backoff) on transient errors;
//    the Shopify client itself backs off on rate limits. The run stops after 5 consecutive failures.
//  - Audit: every repair is recorded by the existing re-sync (the order's shopifySync record and the audit trail, under the admin named with --admin).
//  - Output: CRM order numbers, outcomes and field NAMES only - no customer names, phone numbers or addresses - on screen and in the report file.
import "dotenv/config";
import fs from "node:fs";
import { prisma } from "@/lib/prisma.js";
import OrdersService from "@/modules/orders/orders.service.js";
import { Role } from "../../generated/prisma/enums.js";

const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes("--apply");
const since = new Date(arg("since") ?? "2026-08-01T00:00:00Z");
const limit = Math.min(Math.max(Number(arg("limit") ?? 200), 1), 1000);
const targetOrders = (arg("orders") ?? "").split(",").map((o) => o.trim()).filter(Boolean);
const maxRepairsArg = arg("max-repairs");
const maxRepairs = maxRepairsArg === undefined ? Infinity : Math.max(Number(maxRepairsArg), 0);
const PAUSE_MS = 700;
const ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILURES = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Outcome = "ok" | "would_repair" | "repaired" | "skipped" | "failed";
interface Line { orderNumber: string; outcome: Outcome; reason?: string; fields?: string[]; differsFromCrm?: string[]; billingMissing?: boolean }

/** Runs `fn`, retrying transient failures (network / rate limit / 5xx) with backoff. A permanent answer is returned as is. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error;
      const wait = 1500 * 2 ** (attempt - 1);
      console.log(`  retry    ${label}  attempt ${attempt}/${ATTEMPTS} failed (${error instanceof Error ? error.message.slice(0, 80) : "error"}); waiting ${wait}ms`);
      await sleep(wait);
    }
  }
}

async function main(): Promise<void> {
  if (Number.isNaN(since.getTime())) throw new Error("--since must be a date like 2026-08-01");
  let admin: { id: string; username: string; role: Role } | null = null;
  if (apply) {
    if (arg("confirm") !== "REPAIR-SHOPIFY-ADDRESSES") throw new Error("Refusing to write: run the dry run first, review it, then add --confirm=REPAIR-SHOPIFY-ADDRESSES");
    const username = arg("admin");
    const user = username ? await prisma.user.findFirst({ where: { username, role: Role.ADMIN }, select: { id: true, username: true, role: true } }) : null;
    if (!user) throw new Error("--admin=<username of an ADMIN user> is required with --apply (the repair is audited under that user)");
    admin = user;
  }

  const service = new OrdersService();
  if (targetOrders.some((o) => !/^CRM-[A-Z0-9]+-[A-Z0-9]+$/.test(o))) throw new Error("--orders must be CRM order numbers like CRM-MVJDBMRN-CTA3, comma separated");
  const orders = await prisma.order.findMany({
    where: targetOrders.length > 0 ? { orderNumber: { in: targetOrders }, source: "SALESPERSON", externalId: { not: null } } : { source: "SALESPERSON", externalId: { not: null }, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, orderNumber: true },
  });
  const mode = apply ? "APPLY" : "DRY RUN";
  console.log(`${mode}: ${orders.length} CRM-created, Shopify-linked orders ${targetOrders.length > 0 ? `from the ${targetOrders.length} order numbers given` : `since ${since.toISOString().slice(0, 10)} (limit ${limit})`}`);
  if (targetOrders.length > 0 && orders.length !== targetOrders.length) console.log(`  note: ${targetOrders.length - orders.length} of the given order numbers were not found as CRM-created, Shopify-linked orders and will not be touched`);
  let written = 0;

  const lines: Line[] = [];
  let consecutiveFailures = 0;
  let stopped = false;
  for (const order of orders) {
    const line: Line = { orderNumber: order.orderNumber, outcome: "ok" };
    try {
      const preview = await withRetry(order.orderNumber, () => service.previewShopifyAddress(order.id));
      if (preview.billingMissing) line.billingMissing = true;
      if (preview.differs.length > 0) line.differsFromCrm = preview.differs;
      if (preview.state === "ok") line.outcome = "ok";
      else if (preview.state === "skip") { line.outcome = "skipped"; line.reason = preview.reason; }
      else if (!apply || !admin) { line.outcome = "would_repair"; line.fields = preview.missing; }
      else if (written >= maxRepairs) { line.outcome = "skipped"; line.reason = `--max-repairs=${maxRepairs} reached; not attempted`; }
      else {
        written += 1;
        const result = await withRetry(order.orderNumber, () => service.resyncShopifyOrder(admin, order.id));
        const still = result.sync?.missing.filter((m) => m === "shippingAddress" || m.startsWith("shippingAddress.")) ?? [];
        if (still.length === 0 && result.status !== "failed") { line.outcome = "repaired"; line.fields = preview.missing; }
        else { line.outcome = "failed"; line.fields = still; line.reason = (result.sync?.repairErrors ?? [result.reason ?? "Shopify did not accept the repair"]).join(" | ").slice(0, 200); }
        await sleep(PAUSE_MS);
      }
      consecutiveFailures = line.outcome === "failed" ? consecutiveFailures + 1 : 0;
    } catch (error) {
      line.outcome = "failed";
      line.reason = (error instanceof Error ? error.message : "unknown error").slice(0, 200);
      consecutiveFailures += 1;
    }
    lines.push(line);
    if (line.outcome !== "ok") console.log(`  ${line.outcome.padEnd(12)} ${line.orderNumber}${line.fields?.length ? `  [${line.fields.join(", ")}]` : ""}${line.reason ? `  ${line.reason}` : ""}${line.differsFromCrm ? `  (differs from CRM, left unchanged: ${line.differsFromCrm.join(", ")})` : ""}`);
    if (apply && line.outcome === "failed" && maxRepairs !== Infinity) { console.log("A capped (canary) run stops at the first failure so nothing else is attempted."); stopped = true; break; }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { console.log(`Stopping after ${MAX_CONSECUTIVE_FAILURES} consecutive failures (rate limit or outage?). Nothing further was attempted.`); stopped = true; break; }
    await sleep(apply ? 0 : 350); // the dry run also paces its Shopify reads
  }

  const count = (o: Outcome) => lines.filter((l) => l.outcome === o).length;
  const summary = { mode, examined: lines.length, ok: count("ok"), would_repair: count("would_repair"), repaired: count("repaired"), skipped: count("skipped"), failed: count("failed"), billingMissing_notRepairable: lines.filter((l) => l.billingMissing).length, differsFromCrm_leftUnchanged: lines.filter((l) => l.differsFromCrm).length, stoppedEarly: stopped };
  const reportPath = arg("report") ?? `shopify-address-repair-${apply ? "apply" : "dryrun"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), since: since.toISOString(), summary, orders: lines.filter((l) => l.outcome !== "ok") }, null, 2));
  console.log("Summary:", JSON.stringify(summary));
  console.log(`Report written to ${reportPath}`);
  if (!apply && summary.would_repair > 0) console.log("Nothing was changed. Review the report, then run with --apply --confirm=REPAIR-SHOPIFY-ADDRESSES --admin=<admin>.");
}

main()
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
