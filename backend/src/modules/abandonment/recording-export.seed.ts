import { randomUUID } from "node:crypto";
import { Prisma } from "../../../generated/prisma/client.js";
import type { prisma as PrismaSingleton } from "@/lib/prisma.js";

// Test-only: bulk-creates a realistic abandoned-leads world (leads with an abandoned checkout, outbound calls with recordings spread over many days, a few
// without a link, some sharing one link) in ONE statement per table, so a year of data (10,000+ recordings) seeds in seconds. Everything is tagged, so cleanup removes
// exactly what was created. For the ISOLATED database only (the db-tests and the launcher refuse anything else).

type Db = typeof PrismaSingleton;

export interface SeedOptions {
  /** Number of leads (each has one abandonment). */
  leads: number;
  /** Calls per lead, each with a recording row. */
  callsPerLead: number;
  /** Calls are spread evenly over this many days back from `end`. */
  days: number;
  end?: Date;
  /** Every n-th recording has no link (0 = none). */
  noLinkEvery?: number;
  /** Every n-th recording reuses the previous recording's link (0 = none). */
  duplicateEvery?: number;
  host?: string;
}

export interface SeededWorld {
  tag: string;
  admin: { id: string; role: "ADMIN"; username: string };
  manager: { id: string; role: "MANAGER"; username: string };
  telecaller: { id: string; role: "SALESPERSON"; username: string };
  totalCalls: number;
  from: string; // YYYY-MM-DD (IST) of the oldest call
  to: string; // YYYY-MM-DD (IST) of the newest call
  cleanup(): Promise<void>;
}

const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

export async function seedRecordingWorld(db: Db, options: SeedOptions): Promise<SeededWorld> {
  const tag = randomUUID().slice(0, 8);
  const end = options.end ?? new Date();
  const host = options.host ?? "rec.callerdesk.io";
  const mk = async (role: "ADMIN" | "MANAGER" | "SALESPERSON") => {
    const u = await db.user.create({ data: { name: `Export ${role} ${tag}`, username: `exp-${role.toLowerCase()}-${tag}`, role } });
    return { id: u.id, role, username: u.username } as never;
  };
  const admin = (await mk("ADMIN")) as SeededWorld["admin"];
  const manager = (await mk("MANAGER")) as SeededWorld["manager"];
  const telecaller = (await mk("SALESPERSON")) as SeededWorld["telecaller"];

  const total = options.leads * options.callsPerLead;
  const spanMs = options.days * 86_400_000;
  const noLink = options.noLinkEvery ?? 0;
  const dup = options.duplicateEvery ?? 0;

  await db.$executeRaw(Prisma.sql`
    INSERT INTO leads (id, lead_number, first_name, last_name, mobile, normalized_mobile, assigned_manager_id, updated_at)
    SELECT gen_random_uuid(), ${"EXP-" + tag + "-"} || g, 'Customer' || g, 'Test', '9' || lpad(g::text, 9, '0'), '+919' || lpad(g::text, 9, '0'), ${manager.id}::uuid, now()
    FROM generate_series(1, ${options.leads}::int) g`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO abandonments (id, lead_id, type, detected_at, cart_snapshot, updated_at)
    SELECT gen_random_uuid(), l.id, 'CHECKOUT', ${end}::timestamp - ((row_number() OVER (ORDER BY l.lead_number)) % 30) * interval '1 hour',
           '{"currency":"INR","itemCount":1,"itemNames":["Item"],"cartValue":"499.00"}'::jsonb, now()
    FROM leads l WHERE l.lead_number LIKE ${"EXP-" + tag + "-%"}`);
  // calls: n = 1..total, call n belongs to lead ((n-1) % leads)+1, spread over the span (oldest first)
  await db.$executeRaw(Prisma.sql`
    INSERT INTO calls (id, lead_id, agent_id, provider, direction, status, started_at, created_at, updated_at, duration_seconds)
    SELECT gen_random_uuid(), l.id, ${telecaller.id}::uuid, 'test', 'OUTBOUND', 'COMPLETED',
           ${end}::timestamp - (${spanMs}::numeric * (1 - (n::numeric / ${total}::numeric))) * interval '1 millisecond', now(), now(), 30 + (n % 240)
    FROM generate_series(1, ${total}::int) n
    JOIN leads l ON l.lead_number = ${"EXP-" + tag + "-"} || (((n - 1) % ${options.leads}::int) + 1)`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO call_recordings (id, call_id, recording_url, status, created_at)
    SELECT gen_random_uuid(), c.id,
      CASE WHEN ${noLink} > 0 AND c.rn % ${noLink || 1} = 0 THEN NULL
           WHEN ${dup} > 0 AND c.rn % ${dup || 1} = 0 THEN ${"https://" + host + "/" + tag + "/"} || (c.rn - 1) || '.mp3'
           ELSE ${"https://" + host + "/" + tag + "/"} || c.rn || '.mp3' END,
      'READY', now()
    FROM (SELECT cl.id, row_number() OVER (ORDER BY cl.started_at, cl.id) AS rn FROM calls cl JOIN leads l ON l.id = cl.lead_id WHERE l.lead_number LIKE ${"EXP-" + tag + "-%"}) c`);

  const range = await db.$queryRaw<{ lo: Date; hi: Date }[]>(Prisma.sql`SELECT min(c.started_at) lo, max(c.started_at) hi FROM calls c JOIN leads l ON l.id = c.lead_id WHERE l.lead_number LIKE ${"EXP-" + tag + "-%"}`);
  const ids = [admin.id, manager.id, telecaller.id];

  return {
    tag,
    admin,
    manager,
    telecaller,
    totalCalls: total,
    from: istDay(range[0]!.lo),
    to: istDay(range[0]!.hi),
    async cleanup() {
      const like = "EXP-" + tag + "-%";
      await db.$executeRaw(Prisma.sql`DELETE FROM recording_export_jobs WHERE created_by_id IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))})`);
      await db.$executeRaw(Prisma.sql`DELETE FROM activities WHERE lead_id IN (SELECT id FROM leads WHERE lead_number LIKE ${like})`);
      await db.$executeRaw(Prisma.sql`DELETE FROM lead_assignments WHERE lead_id IN (SELECT id FROM leads WHERE lead_number LIKE ${like})`);
      await db.$executeRaw(Prisma.sql`DELETE FROM call_recordings WHERE call_id IN (SELECT c.id FROM calls c JOIN leads l ON l.id = c.lead_id WHERE l.lead_number LIKE ${like})`);
      await db.$executeRaw(Prisma.sql`DELETE FROM calls WHERE lead_id IN (SELECT id FROM leads WHERE lead_number LIKE ${like})`);
      await db.$executeRaw(Prisma.sql`DELETE FROM abandonments WHERE lead_id IN (SELECT id FROM leads WHERE lead_number LIKE ${like})`);
      await db.$executeRaw(Prisma.sql`DELETE FROM leads WHERE lead_number LIKE ${like}`);
      await db.$executeRaw(Prisma.sql`DELETE FROM users WHERE id IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))})`);
      await db.$executeRaw(Prisma.sql`DELETE FROM users WHERE username LIKE ${"exp-extra-" + tag + "-%"}`);
    },
  };
}
