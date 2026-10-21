// READ-ONLY correlation of stored Shiprocket "Abandon Cart" webhook events with specific abandonment records of one lead.
//   npx tsx src/scripts/abandonment-webhook-correlation.ts --lead-number=LEAD-XXXX --record-ids=<uuid>,<uuid> --expect-host=<exact db host> [--hours=3] [--json]
// Safety: SELECT-only queries (each checked by assertSelectOnly), run inside BEGIN READ ONLY on a session with default_transaction_read_only = on, and only after the
// target host EXACTLY matches --expect-host. Fingerprints of cart references are computed INSIDE the database; raw payloads, references, names, phones and emails are never
// selected or printed. Output is limited to event ids, timestamps, event types, delivery ids (first 8 hash chars), statuses and 8-char fingerprints.
import "dotenv/config";
// @ts-expect-error pg ships no type declarations in this project
const pg: any = (await import("pg")).default;
import { hostMatches, parseTarget } from "./duplicate-leads-report.safety.js";
import { READ_ONLY_SETUP, assertSelectOnly, validateLeadNumber } from "./abandonment-duplicates-report.logic.js";
import {
  ACTIVITIES_SQL, CONCLUSION_WORDING, EVENTS_SQL, RECORDS_SQL, analyze, validateRecordIds,
  type ActivityRow, type EventRow, type RecordRow,
} from "./abandonment-webhook-correlation.logic.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
const asJson = process.argv.includes("--json");
const leadNumber = validateLeadNumber(arg("lead-number"));
const recordIds = validateRecordIds((arg("record-ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const hours = Math.min(48, Math.max(1, Math.floor(Number(arg("hours") ?? 3)) || 3));
const EVENT_CAP = 500;

if (!leadNumber || !recordIds) {
  console.error("Pass --lead-number=<LEAD-...> and --record-ids=<uuid>[,<uuid>...] (valid UUIDs, at most 10).");
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

let records: RecordRow[] = [];
let activities: ActivityRow[] = [];
let events: EventRow[] = [];
try {
  await client.query("SET default_transaction_read_only = on");
  for (const stmt of READ_ONLY_SETUP) await client.query(stmt);
  for (const sql of [RECORDS_SQL, ACTIVITIES_SQL, EVENTS_SQL]) assertSelectOnly(sql);
  records = (await client.query(RECORDS_SQL, [leadNumber, recordIds])).rows;
  activities = (await client.query(ACTIVITIES_SQL, [leadNumber, recordIds])).rows;
  if (records.length > 0) events = (await client.query(EVENTS_SQL, [leadNumber, recordIds, hours, EVENT_CAP])).rows;
  await client.query("ROLLBACK");
} catch (error) {
  console.error(`Query failed (${(error as { code?: string })?.code ?? "unknown error"}). Nothing was changed.`);
  process.exit(2);
} finally {
  await client.end().catch(() => undefined);
}

if (records.length === 0) {
  console.log("None of the given record ids belong to that lead number - nothing to correlate.");
  process.exit(0);
}
const analysis = analyze(records, events, activities);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

if (asJson) {
  console.log(JSON.stringify({ analysis, events: events.map((e) => ({ ...e, received_at: iso(e.received_at), processed_at: iso(e.processed_at), next_attempt_at: iso(e.next_attempt_at) })), eventCapReached: events.length >= EVENT_CAP }, null, 2));
  process.exit(0);
}

console.log("READ-ONLY correlation - nothing was changed. Fingerprints are the first 8 hex chars of a SHA-256 computed in the database.\n");
console.log("== Records");
console.table(records.map((r) => ({ id: r.id, status: r.status, stage: r.stage, ref_fp: r.ref_fp, created: iso(r.created_at), updated: iso(r.updated_at) })));
console.log("== Activities written for those records (system title and time only)");
console.table(activities.map((a) => ({ id: a.id, record: a.abandonment_id, at: iso(a.created_at), title: a.title, source: a.source })));
console.log(`== Stored webhook events matching this lead's contact, within ±${hours} h of the records (${events.length}${events.length >= EVENT_CAP ? ", CAP REACHED - may be incomplete" : ""})`);
console.table(events.map((e) => ({
  event_id: e.id, type: e.event_type, received: iso(e.received_at), processed: iso(e.processed_at), status: e.status, attempts: e.attempts, delivery: e.delivery_id,
  ref_key: e.ref_key, ref_fp: e.ref_fp, stage: e.stage, items_fp: e.items_fp, value: e.cart_value, matched_on: [e.phone_match && "phone", e.email_match && "email"].filter(Boolean).join("+"),
  fp_cart_id: e.fp_cart_id, fp_checkout_id: e.fp_checkout_id, fp_session_id: e.fp_session_id, fp_id: e.fp_id, fp_cart_token: e.fp_cart_token, fp_token: e.fp_token,
})));
console.log("== Link of each record to events (by reference fingerprint; creation candidates = finished within 2 s before to 120 s after the record's created time)");
console.table(analysis.recordLinks.map((l) => ({ record: l.recordId, ref_fp: l.refFp, linked_events: l.linkedEventIds.join(" "), creation_candidates: l.creationCandidateEventIds.join(" "), latest_event_stage: l.latestLinkedEventStage, activities: l.activityTitles.map((a) => a.title).join(" | ") })));
console.log(`Events linked to neither record: ${analysis.eventsLinkedToNeither.length ? analysis.eventsLinkedToNeither.join(", ") : "none"}`);
console.log(`Identifier fields identical across ALL linked events of both records: ${analysis.sharedStableKeys.length ? analysis.sharedStableKeys.join(", ") : "none"}`);
console.log(`Events of the two references interleave in time: ${analysis.intervalsInterleave ?? "unknown"}; cart contents/value identical: ${analysis.contentsIdentical ?? "unknown"}; known stages only move forward: ${analysis.stagesMoveForward ?? "unknown"}\n`);
for (const [name, h] of Object.entries(analysis.hypotheses)) console.log(`${name}: ${h.verdict}\n${h.reasons.map((r) => `  - ${r}`).join("\n")}`);
console.log(`\nRESULT: ${CONCLUSION_WORDING[analysis.conclusion]}\n\nLimits of this evidence:`);
for (const c of analysis.caveats) console.log(`  - ${c}`);
