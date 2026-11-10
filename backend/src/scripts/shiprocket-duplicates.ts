// Lists CRM orders that have more than one live Shiprocket order, for MANUAL review.
//   npm run shiprocket:duplicates -- --since 2026-11-01 --limit 500
//
// Read-only: only GET /orders?search=... is sent to Shiprocket and only SELECTs run against the database. It never cancels, deletes, creates or changes an order, shipment or amount.
// It reads whichever database DATABASE_URL points to - check that first.
import "dotenv/config";
import { scanShiprocketDuplicates } from "../modules/shiprocket/shiprocket.duplicates.js";
import { ShiprocketClient } from "../modules/shiprocket/shiprocket.client.js";
import { loadShiprocketConfig } from "../modules/shiprocket/shiprocket.config.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const since = arg("since") ? new Date(`${arg("since")}T00:00:00+05:30`) : undefined;
const limit = arg("limit") ? Number(arg("limit")) : 500;
if (since && Number.isNaN(since.getTime())) throw new Error("--since must be YYYY-MM-DD");

const config = loadShiprocketConfig(process.env);
if (!config) throw new Error("Shiprocket is not configured");
const { prisma } = await import("../lib/prisma.js");
try {
  const client = new ShiprocketClient(config as never);
  const findings = await scanShiprocketDuplicates(prisma as never, (id) => client.findOrdersByChannelId(id), { since, limit });
  console.log(JSON.stringify(findings, null, 2));
  console.log(`${findings.length} order(s) need manual review. Nothing was changed.`);
} finally {
  await prisma.$disconnect();
}
