// READ-ONLY dry-run report of leads that share a phone number (in any stored shape) or an email, with
// everything linked to each, so a human can decide what - if anything - to merge.
//   npx tsx src/scripts/duplicate-leads-report.ts [--json]
// Prints no names, owners or credentials, and phone numbers only as their last four digits - ids and counts otherwise. It only runs SELECTs, inside a session forced to read-only; it never merges, deletes or updates.
import "dotenv/config";
// The script only issues plain SELECTs.
// @ts-expect-error pg ships no type declarations in this project
const pg: any = (await import("pg")).default;
import { normalizeMobile } from "../lib/leadIdentity.js";
import { hostMatches, maskGroupKey, maskPhone, parseTarget } from "./duplicate-leads-report.safety.js";

const asJson = process.argv.includes("--json");
const expectHost = process.argv.find((a) => a.startsWith("--expect-host="))?.slice("--expect-host=".length).trim();

// Target: REPORT_DATABASE_URL if set (so a production URL can be supplied for one run without touching
// .env), otherwise the same DIRECT_URL / DATABASE_URL the CLI uses. Only the host and database NAME are
// ever printed - never the user, password or query string, and a malformed URL gets a generic message.
const connectionString = process.env.REPORT_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
const target = parseTarget(connectionString);
if (!target.ok) {
  console.error("The configured database URL is missing or malformed. Check it in your environment (it is not printed here).");
  process.exit(2);
}
console.log(`Target database: host=${target.host.replace("-pooler", "")} db=${target.db}`);
if (!hostMatches(target.host, expectHost)) {
  console.log("Refusing to run: pass --expect-host=<the exact host name you intend to inspect> to confirm the target above.");
  process.exit(2);
}

const client = new pg.Client({ connectionString });
try {
  await client.connect();
} catch (error) {
  // Connection errors can echo connection details, so only a generic line (and the error code) is shown.
  console.error(`Could not connect to the database (${(error as { code?: string })?.code ?? "unknown error"}).`);
  process.exit(2);
}
// Defence in depth: the session itself rejects any write.
await client.query("SET default_transaction_read_only = on");

interface LeadRow {
  id: string; lead_number: string; normalized_mobile: string | null; normalized_email: string | null;
  created_at: Date; calls: string; abandonments: string; orders: string; activities: string; tasks: string; whatsapp: string;
}

const { rows }: { rows: LeadRow[] } = await client.query(`
  select l.id, l.lead_number, l.normalized_mobile, l.normalized_email, l.created_at,
         (select count(*) from calls where lead_id = l.id) as calls,
         (select count(*) from abandonments where lead_id = l.id) as abandonments,
         (select count(*) from orders where lead_id = l.id) as orders,
         (select count(*) from activities where lead_id = l.id) as activities,
         (select count(*) from tasks where lead_id = l.id) as tasks,
         (select count(*) from whatsapp_messages where lead_id = l.id) as whatsapp
  from leads l
  order by l.created_at`);

// Group by the canonical number (so "9876543210", "919876543210" and "+919876543210" fall together) or email.
const groups = new Map<string, LeadRow[]>();
const add = (key: string, row: LeadRow) => groups.set(key, [...(groups.get(key) ?? []), row]);
for (const row of rows) {
  const phone = normalizeMobile(row.normalized_mobile);
  if (phone) add(`phone:${phone}`, row);
  if (row.normalized_email) add(`email:${row.normalized_email}`, row);
}
const duplicates = [...groups].filter(([, g]) => g.length > 1);

const abandonmentDupes = (await client.query(`
  select lead_id, type, reference_id, count(*) as n, array_agg(id order by created_at) as abandonment_ids, array_agg(status order by created_at) as statuses
  from abandonments group by 1,2,3 having count(*) > 1`)).rows;
const callDupes = (await client.query(`
  select provider, provider_call_id, count(*) as n, array_agg(id order by created_at) as call_ids
  from calls where provider_call_id is not null group by 1,2 having count(*) > 1`)).rows;

await client.end();

if (asJson) {
  console.log(JSON.stringify({ duplicateLeadGroups: duplicates.map(([key, g]) => ({ key: maskGroupKey(key), leads: g.map(({ normalized_email: _e, normalized_mobile, ...rest }) => ({ ...rest, normalized_mobile: normalized_mobile ? maskPhone(normalized_mobile) : null })) })), abandonmentDupes, callDupes }, null, 2));
} else {
  console.log(`Leads scanned: ${rows.length}. Groups sharing a phone/email: ${duplicates.length}. (read-only - nothing was changed)\n`);
  for (const [key, g] of duplicates) {
    console.log(`== ${maskGroupKey(key)}`);
    console.table(g.map((r) => ({
      id: r.id, number: r.lead_number, stored_mobile: r.normalized_mobile ? maskPhone(r.normalized_mobile) : null, created: r.created_at.toISOString().slice(0, 10),
      calls: r.calls, abandon: r.abandonments, orders: r.orders, acts: r.activities, tasks: r.tasks, wa: r.whatsapp,
    })));
  }
  console.log(`Abandonments sharing (lead, type, cart id): ${abandonmentDupes.length}`);
  if (abandonmentDupes.length) console.table(abandonmentDupes);
  console.log(`Calls sharing (provider, provider_call_id): ${callDupes.length}`);
  if (callDupes.length) console.table(callDupes);
}
