// Duplicate-resolution report for Shiprocket orders (CSV + Excel). STRICTLY READ-ONLY: database SELECTs and Shiprocket search requests (GET) only - it cancels, deletes, creates and changes nothing.
//   npm run shiprocket:duplicate-report -- --out ./reports [--since YYYY-MM-DD] [--limit N] [--concurrency 4]
// It reads whichever database DATABASE_URL points to and asks the Shiprocket account in the environment - check both first.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { buildDuplicateReport, pairToCells, reportColumns, toCsv } from "../modules/shiprocket/shiprocket.duplicate-report.js";
import { ShiprocketClient } from "../modules/shiprocket/shiprocket.client.js";
import { loadShiprocketConfig } from "../modules/shiprocket/shiprocket.config.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const since = arg("since") ? new Date(`${arg("since")}T00:00:00+05:30`) : undefined;
if (since && Number.isNaN(since.getTime())) throw new Error("--since must be YYYY-MM-DD");
const out = arg("out") ?? "./reports";

const config = loadShiprocketConfig(process.env);
if (!config) throw new Error("Shiprocket is not configured");
const client = new ShiprocketClient(config as never);
const { prisma } = await import("../lib/prisma.js");
try {
  const report = await buildDuplicateReport(prisma as never, { lookup: (id) => client.findOrdersByChannelId(id), since, limit: arg("limit") ? Number(arg("limit")) : undefined, concurrency: arg("concurrency") ? Number(arg("concurrency")) : 4 });
  mkdirSync(out, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const csvPath = join(out, `shiprocket-duplicates-${stamp}.csv`);
  const xlsxPath = join(out, `shiprocket-duplicates-${stamp}.xlsx`);
  writeFileSync(csvPath, toCsv(report));

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Duplicate pairs");
  sheet.addRow(reportColumns()).font = { bold: true };
  for (const p of report.pairs) sheet.addRow(pairToCells(p).map((v) => (typeof v === "string" && /^[=+\-@]/.test(v) ? `'${v}` : v)));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const summary = wb.addWorksheet("Summary");
  summary.addRows([["Orders checked", report.checkedOrders], ["Duplicate pairs", report.pairs.length], ...Object.entries(report.totals), ["Lookups that failed (not classified)", report.lookupErrors.length]]);
  if (report.lookupErrors.length) { const e = wb.addWorksheet("Lookup errors"); e.addRows([["crm_order_id", "error"], ...report.lookupErrors.map((x) => [x.crmOrderNumber, x.error])]); }
  await wb.xlsx.writeFile(xlsxPath);

  console.log(`Orders checked: ${report.checkedOrders}\nDuplicate pairs: ${report.pairs.length}`);
  for (const [k, v] of Object.entries(report.totals)) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`Lookups that failed (not classified): ${report.lookupErrors.length}\nCSV:   ${csvPath}\nExcel: ${xlsxPath}\nNothing was cancelled, deleted, created or changed.`);
} finally {
  await prisma.$disconnect();
}
