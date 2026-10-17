// READ-ONLY dry-run for ONE candidate pair of duplicate leads. It never merges, updates, inserts or deletes:
//   - every query goes through assertSelectOnly (one plain SELECT, no write keyword) before it is sent
//   - the session is forced read-only (SET default_transaction_read_only = on) before the first query
//   - the target host must be confirmed with an EXACT --expect-host, and only host/db name is ever printed
//   - phone and email are masked in all output
//
//   npx tsx src/scripts/duplicate-lead-merge-dryrun.ts --leads=LEAD-AAAA,LEAD-BBBB --expect-host=<exact host>
//
// Use REPORT_DATABASE_URL (a NON-pooled URL) to point it at a specific database for one run.
import "dotenv/config";
// @ts-expect-error pg ships no type declarations in this project
const pg: any = (await import("pg")).default;
import { hostMatches, parseTarget } from "./duplicate-leads-report.safety.js";
import { assertSelectOnly, buildMergePlan, formatPlan, LEAD_REFERENCES, refKey, type LeadEvidence, type Overlaps } from "./duplicate-lead-merge-plan.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
const leadNumbers = (arg("leads") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const expectHost = arg("expect-host");

if (leadNumbers.length !== 2 || new Set(leadNumbers).size !== 2) {
  console.error("Pass exactly two different lead numbers: --leads=LEAD-AAAA,LEAD-BBBB (this tool handles one candidate pair at a time).");
  process.exit(2);
}

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
  console.error(`Could not connect to the database (${(error as { code?: string })?.code ?? "unknown error"}).`);
  process.exit(2);
}
// Defence in depth: the session itself rejects any write. (The one non-SELECT this script ever sends.)
await client.query("SET default_transaction_read_only = on");

/** The only way this script talks to the database for reading data. */
async function select(sql: string, params: unknown[] = []): Promise<any[]> {
  assertSelectOnly(sql);
  return (await client.query(sql, params)).rows;
}

async function loadLead(leadNumber: string): Promise<LeadEvidence> {
  const [l] = await select(
    `select l.id, l.lead_number, l.first_name, l.last_name, l.normalized_mobile, l.normalized_email,
            s.name as source, u.name as owner_name, u.status as owner_status, m.name as manager_name, g.name as group_name,
            l.created_at, l.last_activity_at, l.last_contacted_at, l.working_status, l.lifecycle_stage,
            l.external_source, l.external_id
       from leads l
       left join sources s on s.id = l.source_id
       left join users u on u.id = l.owner_id
       left join users m on m.id = l.assigned_manager_id
       left join groups g on g.id = l.group_id
      where l.lead_number = $1`,
    [leadNumber],
  );
  if (!l) {
    console.error(`No lead found with number ${leadNumber}.`);
    process.exit(2);
  }

  const counts: Record<string, number> = {};
  for (const ref of LEAD_REFERENCES) {
    // table/column come from the constant LEAD_REFERENCES list, never from input; the id is a parameter.
    const [{ n }] = await select(`select count(*) as n from ${ref.table} where ${ref.column} = $1`, [l.id]);
    counts[refKey(ref)] = Number(n);
  }
  const [{ n: soft }] = await select(`select count(*) as n from activities where reference_type = 'Lead' and reference_id = $1`, [l.id]);
  const [{ latest: latestCall }] = await select(`select max(coalesce(started_at, created_at)) as latest from calls where lead_id = $1`, [l.id]);
  const [{ latest: latestActivity }] = await select(`select max(created_at) as latest from activities where lead_id = $1`, [l.id]);

  return {
    id: l.id, leadNumber: l.lead_number, firstName: l.first_name, lastName: l.last_name,
    normalizedMobile: l.normalized_mobile, normalizedEmail: l.normalized_email, source: l.source,
    owner: l.owner_name ? { name: l.owner_name, status: l.owner_status } : null,
    assignedManager: l.manager_name, group: l.group_name, createdAt: l.created_at,
    lastActivityAt: l.last_activity_at, lastContactedAt: l.last_contacted_at,
    workingStatus: l.working_status, lifecycleStage: l.lifecycle_stage,
    externalSource: l.external_source, externalId: l.external_id,
    counts, softReferenceCount: Number(soft), latestCallAt: latestCall, latestActivityAt: latestActivity,
  };
}

const a = await loadLead(leadNumbers[0]!);
const b = await loadLead(leadNumbers[1]!);

const channels = await select(
  `select channel from communication_preferences where lead_id in ($1, $2) group by channel having count(distinct lead_id) = 2`,
  [a.id, b.id],
);
const campaigns = await select(
  `select campaign_id from whatsapp_campaign_recipients where lead_id in ($1, $2) group by campaign_id having count(distinct lead_id) = 2`,
  [a.id, b.id],
);
const overlaps: Overlaps = { communicationChannels: channels.map((r) => String(r.channel)), campaignIds: campaigns.map((r) => String(r.campaign_id)) };

await client.end();

for (const line of formatPlan(a, b, buildMergePlan(a, b, overlaps))) console.log(line);
