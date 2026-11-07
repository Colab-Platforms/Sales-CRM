import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import LeadService from "../lead/lead.service.js";
import { CANONICAL_POOL, simulateRoundRobin } from "./abandonment.pool.js";

const leadService = new LeadService();
const ASSIGN_TX = { timeout: 20_000, maxWait: 10_000 };

// ELIGIBLE for the sweep and the backfill: no owner, still a NEW lead (never worked, so not CONVERTED / DND / DEACTIVATED / already in progress) with an ACTIVE abandonment - the same kind of lead the automatic
// assignment receives when it arrives. Checked against production: of the 79 unowned abandoned leads only those that are NEW qualify; 49 are CONVERTED, 27 DND, 1 DEACTIVATED. The pool never overwrites an owner.
// Oldest first, so a backfill follows arrival order; `createdFrom` / `createdTo` bound it (the sweep: newer than activation, older than a short grace).
const unassignedWhere = (range: { createdFrom?: Date; createdTo?: Date } = {}) => ({
  abandonments: { some: { status: "ACTIVE" as const } },
  ownerId: null,
  workingStatus: "NEW" as const,
  ...(range.createdFrom || range.createdTo ? { createdAt: { ...(range.createdFrom ? { gte: range.createdFrom } : {}), ...(range.createdTo ? { lte: range.createdTo } : {}) } } : {}),
});

export interface ResolvedMember { username: string; expectedName: string; userId: string | null; name: string | null; status: string | null; problem: string | null }

/** Resolves the canonical usernames to existing users. Never creates anything; a missing / duplicate / disabled / non-telecaller account is reported as a problem and is not usable. */
export async function resolveCanonicalPool(db: typeof prisma = prisma): Promise<ResolvedMember[]> {
  const users = await db.user.findMany({ where: { username: { in: CANONICAL_POOL.map((p) => p.username) } }, select: { id: true, name: true, username: true, role: true, status: true } });
  return CANONICAL_POOL.map((p) => {
    const found = users.filter((u) => u.username === p.username);
    if (found.length === 0) return { username: p.username, expectedName: p.name, userId: null, name: null, status: null, problem: "no such user" };
    const u = found[0]!;
    const problem = found.length > 1 ? "duplicate username" : u.role !== Role.SALESPERSON ? `role is ${u.role}, not SALESPERSON` : u.status !== UserStatus.ACTIVE ? `account is ${u.status}` : u.name.trim().toLowerCase() !== p.name.toLowerCase() ? `name is "${u.name.trim()}", expected "${p.name}"` : null;
    return { username: p.username, expectedName: p.name, userId: u.id, name: u.name.trim(), status: u.status, problem };
  });
}

export interface PoolDryRun {
  enabled: boolean;
  members: { userId: string; name: string }[];
  unassignedLeads: number;
  /** How many of the currently unassigned leads each member would receive, in arrival order, continuing from the stored cursor. */
  plan: { userId: string; name: string; leads: number }[];
}

/** Read-only: which unassigned abandoned leads exist and who would get them. Writes nothing. */
export async function dryRun(db: typeof prisma = prisma): Promise<PoolDryRun> {
  const [state, members, count] = await Promise.all([
    db.abandonedPoolState.findFirst({ orderBy: { id: "asc" } }),
    db.abandonedPoolMember.findMany({ orderBy: [{ position: "asc" }, { id: "asc" }] }),
    db.lead.count({ where: unassignedWhere() }),
  ]);
  const users = await db.user.findMany({ where: { id: { in: members.map((m) => m.userId) }, role: Role.SALESPERSON, status: UserStatus.ACTIVE }, select: { id: true, name: true } });
  const byId = new Map(users.map((u) => [u.id, u.name.trim()]));
  const eligible = members.flatMap((m) => (byId.has(m.userId) ? [{ id: m.userId, name: byId.get(m.userId)! }] : []));
  const seq = simulateRoundRobin(eligible, state?.lastAssignedUserId ?? null, count);
  const tally = new Map<string, number>();
  for (const m of seq) tally.set(m.id, (tally.get(m.id) ?? 0) + 1);
  return { enabled: Boolean(state?.enabled), members: eligible.map((e) => ({ userId: e.id, name: e.name })), unassignedLeads: count, plan: eligible.map((e) => ({ userId: e.id, name: e.name, leads: tally.get(e.id) ?? 0 })) };
}

/** Switches the pool on with exactly these members (in this order), only when every canonical account resolved cleanly. The cursor is kept if the state row exists. Needs explicit approval - the CLI requires --apply. */
export async function configurePool(db: typeof prisma = prisma): Promise<{ ok: boolean; problems: string[] }> {
  const resolved = await resolveCanonicalPool(db);
  const problems = resolved.filter((r) => r.problem).map((r) => `${r.username}: ${r.problem}`);
  if (problems.length > 0) return { ok: false, problems };
  await db.$transaction(async (tx) => {
    // one activation at a time (two admins / instances): serialised, so there is never a second state row
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('abandoned_pool_configure'))`;
    await tx.abandonedPoolMember.deleteMany({});
    await tx.abandonedPoolMember.createMany({ data: resolved.map((r, i) => ({ userId: r.userId!, position: i })) });
    const state = await tx.abandonedPoolState.findFirst({ orderBy: { id: "asc" } });
    if (state) await tx.abandonedPoolState.update({ where: { id: state.id }, data: { enabled: true, enabledAt: state.enabled ? state.enabledAt : new Date() } });
    else await tx.abandonedPoolState.create({ data: { enabled: true, enabledAt: new Date() } });
  }, ASSIGN_TX);
  return { ok: true, problems: [] };
}

export interface AssignRun { considered: number; assigned: number; skipped: number; failed: number }

/** Assigns unassigned abandoned leads one transaction each (a failure on one never blocks the others, and re-running is safe: owned leads are skipped). `createdFrom` limits it to newer leads (the automatic sweep). */
export async function assignUnassigned(opts: { createdFrom?: Date; createdTo?: Date; limit?: number } = {}, db: typeof prisma = prisma): Promise<AssignRun> {
  const leads = await db.lead.findMany({ where: unassignedWhere({ createdFrom: opts.createdFrom, createdTo: opts.createdTo }), orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: opts.limit ?? 500 });
  const run: AssignRun = { considered: leads.length, assigned: 0, skipped: 0, failed: 0 };
  for (const lead of leads) {
    try {
      const r = await db.$transaction((tx) => leadService.autoAssignAbandonedFromPool(tx, lead), ASSIGN_TX);
      if (r.assigned) run.assigned += 1;
      else run.skipped += 1;
    } catch (error) {
      run.failed += 1;
      logger.warn(`abandoned_pool assign_failed lead=${lead.id} reason=${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`);
    }
  }
  return run;
}

/** The automatic retry: leads that arrived after the pool was switched on and are still unowned (an assignment that failed, or a lead created while the database was busy). Older backlog is NOT touched here. */
/** True when the pool tables exist (the migration has been applied). Never raises: code deployed before the migration must be a quiet no-op, not a warning every tick. */
export async function poolTablesExist(db: Pick<typeof prisma, "$queryRaw">): Promise<boolean> {
  const r = await db.$queryRaw<{ s: string | null; m: string | null }[]>`SELECT to_regclass('abandoned_pool_state')::text AS s, to_regclass('abandoned_pool_member')::text AS m`;
  return Boolean(r[0]?.s && r[0]?.m);
}

export async function sweepNewUnassigned(db: typeof prisma = prisma): Promise<AssignRun | null> {
  if (!(await poolTablesExist(db))) return null; // migration not applied yet: nothing to sweep, nothing to log
  const state = await db.abandonedPoolState.findFirst({ orderBy: { id: "asc" } });
  if (!state?.enabled || !state.enabledAt) return null;
  // a short grace so the sweep never races the webhook's own assignment of a lead that was only just saved
  const graceCutoff = new Date(Date.now() - 60_000);
  return assignUnassigned({ createdFrom: state.enabledAt, createdTo: graceCutoff, limit: 200 }, db);
}
