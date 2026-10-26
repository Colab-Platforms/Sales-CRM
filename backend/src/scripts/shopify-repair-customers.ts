import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { prisma } from "../lib/prisma.js";
import { ActivitySource, ActivityType } from "../../generated/prisma/enums.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { ShopifyClient } from "../modules/shopify/shopify.client.js";
import { loadShopifyConfig } from "../modules/shopify/shopify.config.js";
import { repairOrderCustomer, type RepairOutcome } from "../modules/shopify/shopify.customer-repair.js";
import type { RepairPlan } from "../modules/shopify/shopify.order-audit.js";

// Repairs the Shopify CUSTOMER on orders the CRM pushed (link / create / fill a blank name). No amount, payment, refund, cancellation, fulfilment or shipment is touched; orders whose totals differ are never repaired.
//   npm run shopify:repair-customers -- --plan <audit.json> --out <results.json>            DRY RUN (the default): reads, prints and writes what WOULD change; changes nothing
//   npm run shopify:repair-customers -- --plan <audit.json> --out <results.json> --apply    performs the repairs, each one re-reading both records first and skipping any whose state changed
// The plan file is the output of `npm run shopify:audit`. Each applied repair is recorded on the order's history; every result is also in the --out file.

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const apply = process.argv.includes("--apply");
const planFile = arg("--plan");
const outFile = arg("--out");
if (!planFile) throw new Error("--plan <audit.json> is required (run shopify:audit first)");
const plan = (JSON.parse(readFileSync(planFile, "utf-8")).report as { crmOrderId: string; repair: RepairPlan; orderName: string | null }[]).filter((r) => r.repair === "LINK_OR_CREATE_CUSTOMER" || r.repair === "FILL_CUSTOMER_NAME");
console.log(`${apply ? "APPLY" : "DRY RUN"}: ${plan.length} order(s) planned for a customer repair`);

const client = new ShopifyClient(loadShopifyConfig(process.env));
const results: RepairOutcome[] = [];
for (const p of plan) {
  const outcome = await repairOrderCustomer(
    {
      db: prisma as never,
      client,
      record: async (crm, o) => {
        await prisma.activity.create({
          data: {
            leadId: crm.lead.id, orderId: crm.id, type: ActivityType.NOTE, referenceType: "Order", referenceId: crm.id, source: ActivitySource.SYSTEM,
            title: o.status === "repaired" ? `Shopify customer repaired on ${crm.externalNumber ?? crm.orderNumber}` : `Shopify customer repair FAILED on ${crm.externalNumber ?? crm.orderNumber}`,
            description: o.reason, newValue: { plan: o.plan, status: o.status, changes: o.changes } as Prisma.InputJsonValue,
          },
        });
      },
    },
    p.crmOrderId,
    p.repair,
    { apply },
  );
  results.push(outcome);
  console.log(`${outcome.orderName ?? p.crmOrderId}  ${outcome.status.toUpperCase()}  ${outcome.plan}  ${outcome.reason}  [${outcome.changes.join("; ")}]`);
}
const tally = (s: string) => results.filter((r) => r.status === s).length;
console.log(JSON.stringify({ mode: apply ? "apply" : "dry_run", planned: plan.length, repaired: tally("repaired"), wouldChange: tally("dry_run"), skipped: tally("skipped"), failed: tally("failed") }));
if (outFile) writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), mode: apply ? "apply" : "dry_run", results }, null, 1));
await prisma.$disconnect();
