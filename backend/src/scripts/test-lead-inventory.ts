// READ-ONLY before-state inventory for test-lead cleanup planning. It changes nothing:
//   - every query goes through assertSelectOnly (one plain SELECT, no write keyword) before it is sent
//   - the session is forced read-only (SET default_transaction_read_only = on) before the first query
//   - the target host must be confirmed with an EXACT --expect-host; only host/db name is ever printed
//   - phone numbers print as their last four digits, customer names as an initial; no emails are selected at all
//
//   npx tsx src/scripts/test-lead-inventory.ts --leads=LEAD-AAAA,LEAD-BBBB --expect-host=<exact host> [--json]
//
// Customer first names print as an initial and phone numbers as their last four digits; staff names (owner, agent)
// are kept so the Seed / UAT ownership can be verified. Save the --json output BEFORE any cleanup: it is the rollback reference (original status, every linked id).
import "dotenv/config";
// @ts-expect-error pg ships no type declarations in this project
const pg: any = (await import("pg")).default;
import { hostMatches, maskName, maskPhone, parseTarget } from "./duplicate-leads-report.safety.js";
import { assertSelectOnly, LEAD_REFERENCES, refKey } from "./duplicate-lead-merge-plan.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
const asJson = process.argv.includes("--json");
const leadNumbers = (arg("leads") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const expectHost = arg("expect-host");

if (leadNumbers.length < 1 || leadNumbers.length > 5 || new Set(leadNumbers).size !== leadNumbers.length) {
  console.error("Pass 1-5 different lead numbers: --leads=LEAD-AAAA,LEAD-BBBB");
  process.exit(2);
}

const connectionString = process.env.REPORT_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
const target = parseTarget(connectionString);
if (!target.ok) {
  console.error("The configured database URL is missing or malformed. Check it in your environment (it is not printed here).");
  process.exit(2);
}
console.error(`Target database: host=${target.host.replace("-pooler", "")} db=${target.db}`);
if (!hostMatches(target.host, expectHost)) {
  console.error("Refusing to run: pass --expect-host=<the exact host name you intend to inspect> to confirm the target above.");
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

/** The only way this script reads data. */
async function select(sql: string, params: unknown[] = []): Promise<any[]> {
  assertSelectOnly(sql);
  try {
    return (await client.query(sql, params)).rows;
  } catch (error) {
    // A database error message can echo identifiers or values; only a generic line and the SQLSTATE code are shown.
    console.error(`A read query failed (${(error as { code?: string })?.code ?? "unknown error"}). Nothing was changed.`);
    await client.end().catch(() => undefined);
    process.exit(2);
  }
}

const inventory: unknown[] = [];

for (const leadNumber of leadNumbers) {
  const [lead] = await select(
    `select l.id, l.lead_number, l.first_name, l.normalized_mobile, l.working_status, l.lifecycle_stage, l.priority,
            s.name as source, u.name as owner, m.name as manager, g.name as group_name,
            l.created_at, l.updated_at, l.last_activity_at, l.last_contacted_at
       from leads l
       left join sources s on s.id = l.source_id
       left join users u on u.id = l.owner_id
       left join users m on m.id = l.assigned_manager_id
       left join groups g on g.id = l.group_id
      where l.lead_number = $1`,
    [leadNumber],
  );
  if (!lead) {
    console.error(`No lead found with number ${leadNumber}.`);
    process.exit(2);
  }

  const counts: Record<string, number> = {};
  for (const ref of LEAD_REFERENCES) {
    // table/column come from the constant LEAD_REFERENCES list, never from input; the id is a parameter.
    const [{ n }] = await select(`select count(*) as n from ${ref.table} where ${ref.column} = $1`, [lead.id]);
    counts[refKey(ref)] = Number(n);
  }

  const calls = await select(
    `select c.id, c.provider, c.provider_call_id, c.direction, c.status, c.call_group, c.started_at, c.ended_at, c.duration_seconds,
            c.customer_number, a.name as agent, r.id as recording_id, t.id as transcript_id, o.name as outcome
       from calls c
       left join users a on a.id = c.agent_id
       left join call_recordings r on r.call_id = c.id
       left join call_transcripts t on t.call_id = c.id
       left join call_outcomes o on o.id = c.outcome_id
      where c.lead_id = $1
      order by c.created_at`,
    [lead.id],
  );
  const activities = await select(
    `select id, type, title, source, reference_type, reference_id, created_at from activities where lead_id = $1 order by created_at`,
    [lead.id],
  );
  // Activities that point at one of this lead's calls by reference_id (not a foreign key to leads).
  const callRefActivities = await select(
    `select a.id, a.reference_type, a.reference_id from activities a
      where a.reference_id in (select id::text from calls where lead_id = $1) and (a.lead_id is distinct from $2)`,
    [lead.id, lead.id],
  );
  // Raw webhook deliveries for this lead's calls. webhook_events has no lead foreign key; they are matched by CallSid.
  const webhookEvents = await select(
    `select id, provider, event_type, status, received_at from webhook_events
      where provider = 'callerdesk' and payload->>'CallSid' in (select provider_call_id from calls where lead_id = $1 and provider_call_id is not null)
      order by received_at`,
    [lead.id],
  );

  inventory.push({
    lead: {
      id: lead.id, leadNumber: lead.lead_number, firstName: maskName(lead.first_name), phone: lead.normalized_mobile ? maskPhone(lead.normalized_mobile) : null,
      workingStatus: lead.working_status, lifecycleStage: lead.lifecycle_stage, priority: lead.priority, source: lead.source, owner: lead.owner,
      assignedManager: lead.manager, group: lead.group_name, createdAt: lead.created_at, updatedAt: lead.updated_at,
      lastActivityAt: lead.last_activity_at, lastContactedAt: lead.last_contacted_at,
    },
    linkedCounts: counts,
    calls: calls.map((c) => ({
      id: c.id, providerCallId: c.provider_call_id, direction: c.direction, status: c.status, callGroup: c.call_group, startedAt: c.started_at,
      durationSeconds: c.duration_seconds, customer: c.customer_number ? maskPhone(c.customer_number) : null, agent: c.agent, outcome: c.outcome,
      recordingId: c.recording_id, transcriptId: c.transcript_id,
    })),
    activities,
    activitiesReferencingTheseCalls: callRefActivities,
    webhookEvents,
  });
}

await client.end();

if (asJson) {
  console.log(JSON.stringify(inventory, null, 2));
} else {
  for (const item of inventory as any[]) {
    console.log(`\n== ${item.lead.leadNumber}  id=${item.lead.id}  status=${item.lead.workingStatus}  stage=${item.lead.lifecycleStage}`);
    console.log(`   owner=${item.lead.owner ?? "-"}  manager=${item.lead.assignedManager ?? "-"}  group=${item.lead.group ?? "-"}  source=${item.lead.source ?? "-"}  phone=${item.lead.phone ?? "-"}`);
    console.log(`   created=${new Date(item.lead.createdAt).toISOString()}  updated=${new Date(item.lead.updatedAt).toISOString()}`);
    console.log("   linked counts:", Object.entries(item.linkedCounts).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(", ") || "none");
    console.table(item.calls);
    console.table(item.activities);
    console.log(`   activities that reference these calls by id: ${item.activitiesReferencingTheseCalls.length}; raw webhook events matched by CallSid: ${item.webhookEvents.length}`);
  }
  console.error("\n(read-only - nothing was changed. Re-run with --json and save the output as the rollback reference.)");
}
