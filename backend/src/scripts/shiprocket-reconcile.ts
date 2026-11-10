// Reconciles existing Shiprocket orders with their Shopify orders (see modules/shiprocket/shiprocket.reconcile.ts).
//   npm run shiprocket:reconcile                      dry run (default): reads only, prints the report
//   npm run shiprocket:reconcile -- --remote          also ask Shiprocket (read-only searches) to confirm each match and to find duplicates
//   npm run shiprocket:reconcile -- --apply           writes the CRM-side mapping (metadata only) for the verified matches
//   options: --since YYYY-MM-DD   --limit N
//
// It never creates, updates, cancels or deletes anything in Shiprocket or Shopify, and never touches status, AWB, courier, tracking, payments or history.
// It reads (and with --apply writes metadata in) whichever database DATABASE_URL points to - check that first.
import "dotenv/config";
import { formatReconcileReport, reconcileShiprocketOrders } from "../modules/shiprocket/shiprocket.reconcile.js";
import { ShiprocketClient } from "../modules/shiprocket/shiprocket.client.js";
import { loadShiprocketConfig } from "../modules/shiprocket/shiprocket.config.js";

const has = (name: string) => process.argv.includes(`--${name}`);
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const since = arg("since") ? new Date(`${arg("since")}T00:00:00+05:30`) : undefined;
if (since && Number.isNaN(since.getTime())) throw new Error("--since must be YYYY-MM-DD");

let lookup: ((id: string) => Promise<never>) | undefined;
if (has("remote")) {
  const config = loadShiprocketConfig(process.env);
  if (!config) throw new Error("Shiprocket is not configured, so --remote cannot be used");
  const client = new ShiprocketClient(config as never);
  lookup = ((id: string) => client.findOrdersByChannelId(id)) as never;
}
const { prisma } = await import("../lib/prisma.js");
try {
  const report = await reconcileShiprocketOrders(prisma as never, { apply: has("apply"), since, limit: arg("limit") ? Number(arg("limit")) : undefined, lookup });
  console.log(formatReconcileReport(report));
} finally {
  await prisma.$disconnect();
}
