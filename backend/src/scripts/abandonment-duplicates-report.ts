// READ-ONLY diagnostic for repeated CHECKOUT abandonment records. It reports facts and labels the uncertainty; it never decides a row is safe to delete.
//   npx tsx src/scripts/abandonment-duplicates-report.ts --lead-number=LEAD-XXXX --expect-host=<exact db host> [--broad] [--limit=2000] [--json]
// Safety: SELECT-only queries (each checked by assertSelectOnly), run inside BEGIN READ ONLY on a session with default_transaction_read_only = on, and only
// after the target host EXACTLY matches --expect-host. Prints no URL, credentials, name, phone, email, webhook payload or full cart reference (references
// appear as a masked form plus a short fingerprint). It never updates, deletes, merges or migrates anything.
import "dotenv/config";
// @ts-expect-error pg ships no type declarations in this project
const pg: any = (await import("pg")).default;
import { hostMatches, parseTarget } from "./duplicate-leads-report.safety.js";
import {
  BROAD_OPEN_SQL, LEAD_RECORDS_SQL, PATTERN_NOTES, READ_ONLY_SETUP, assertSelectOnly, summarizeBroad, summarizeLead, timingNote, toView, validateLeadNumber,
  type LeadSummary, type RawRow,
} from "./abandonment-duplicates-report.logic.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
const asJson = process.argv.includes("--json");
const broad = process.argv.includes("--broad");
const leadNumber = validateLeadNumber(arg("lead-number"));
const limit = Math.min(5000, Math.max(1, Number(arg("limit") ?? 2000) || 2000));

if (!leadNumber && !broad) {
  console.error("Pass --lead-number=<LEAD-...> and/or --broad.");
  process.exit(2);
}
if (arg("lead-number") !== undefined && !leadNumber) {
  console.error("--lead-number must be letters, digits and dashes only (max 50 characters).");
  process.exit(2);
}

const connectionString = process.env.REPORT_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
const target = parseTarget(connectionString);
if (!target.ok) {
  console.error("The configured database URL is missing or malformed. Check it in your environment (it is not printed here).");
  process.exit(2);
}
console.log(`Target database: host=${target.host.replace("-pooler", "")} db=${target.db}`);
if (!hostMatches(target.host, arg("expect-host"))) {
  console.log("Refusing to run: pass --expect-host=<the exact host name you intend to inspect> to confirm the target above.");
  process.exit(2);
}

const client = new pg.Client({ connectionString });
try {
  await client.connect();
} catch (error) {
  console.error(`Could not connect to the database (${(error as { code?: string })?.code ?? "unknown error"}).`);
  process.exit(2);
}

let leadRows: RawRow[] = [];
let broadRows: RawRow[] = [];
try {
  await client.query("SET default_transaction_read_only = on");
  for (const stmt of READ_ONLY_SETUP) await client.query(stmt);
  if (leadNumber) {
    assertSelectOnly(LEAD_RECORDS_SQL);
    leadRows = (await client.query(LEAD_RECORDS_SQL, [leadNumber])).rows;
  }
  if (broad) {
    assertSelectOnly(BROAD_OPEN_SQL);
    broadRows = (await client.query(BROAD_OPEN_SQL, [limit])).rows;
  }
  await client.query("ROLLBACK");
} catch (error) {
  console.error(`Query failed (${(error as { code?: string })?.code ?? "unknown error"}). Nothing was changed.`);
  process.exit(2);
} finally {
  await client.end().catch(() => undefined);
}

const lead = leadNumber ? summarizeLead(leadRows) : null;
const broadSummary = broad ? summarizeBroad(broadRows) : [];

if (asJson) {
  console.log(JSON.stringify({ lead: lead && { ...lead, records: leadRows.map(toView) }, broad: broadSummary, broadRowCap: broad ? { limit, reached: broadRows.length >= limit } : null }, null, 2));
  process.exit(0);
}

function printSummary(s: LeadSummary) {
  console.log(`Lead ${s.leadNumber} (id ${s.leadId}): ${s.totalCheckoutRecords} checkout record(s), ${s.openRecords} open.`);
  for (const p of s.patterns) console.log(`  [${p}] ${PATTERN_NOTES[p]}`);
  if (s.repeatedGroups.length === 0) console.log("  No open group (same reference + stage) has more than one record.");
  for (const g of s.repeatedGroups) {
    console.log(`  Repeated open group: reference ${g.reference}, stage ${g.stage ?? "(none)"}, ${g.count} records, ${timingNote(g.createdSpanMs)}`);
    console.log(`    record ids: ${g.recordIds.join(", ")}`);
    console.log(`    activities per record (each normal create writes one): ${g.activitiesPerRecord.join(", ")}`);
  }
}

console.log("READ-ONLY report - nothing was changed. This report shows what is stored; it does not establish why, and does not say any record is safe to delete.\n");
if (lead) {
  console.log("== Checkout abandonment records for the target lead (all statuses, oldest first)");
  console.table(leadRows.map(toView).map((v) => ({
    id: v.id, status: v.status, reference: v.reference, stage: v.stage, value: v.cartValue, created: v.createdAt, updated: v.updatedAt, detected: v.detectedAt,
    recovered: v.recoveredAt, acts: v.activities, recov_actions: v.recoveryActions,
  })));
  console.log("== Open groups for the target lead");
  printSummary(lead);
} else if (leadNumber) {
  console.log("No CHECKOUT abandonment records were found for that lead number (or the lead number does not exist).");
}
if (broad) {
  console.log(`\n== Other leads with more than one open checkout abandonment (scan capped at ${limit} rows${broadRows.length >= limit ? " - CAP REACHED, list may be incomplete" : ""})`);
  console.log(`Leads listed: ${broadSummary.length}`);
  for (const s of broadSummary) printSummary(s);
}
