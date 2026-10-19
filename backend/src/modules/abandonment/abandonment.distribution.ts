import { Prisma } from "../../../generated/prisma/client.js";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { getManagerTeam, type DbClient } from "@/lib/leadScope.js";
import { abandonmentDateRangeBounds } from "./abandonment.filters.js";
import type { AbandonmentDateRange } from "./abandonment.types.js";

// Lead distribution of the abandoned-leads queue: how many abandoned checkouts exist, how many have a telecaller, and each telecaller's share.
//
// DEFINITIONS (every number below is one of these - they are never mixed):
//   abandoned in a period  = Abandonment.detectedAt (when the checkout was abandoned) inside that IST day.
//   assigned (to a telecaller) = the lead currently has an owner (Lead.ownerId, the telecaller). "Unassigned" = no telecaller yet (a manager may already hold it).
//   currently assigned     = the checkout's lead is owned by that telecaller NOW, whenever it was abandoned or assigned.
//   assigned during a period = the telecaller's CURRENT assignment (LeadAssignment.isCurrent) was made inside that IST day (by assignment time, not abandon time).
// Counts are of abandoned checkouts (Abandonment rows), the same unit the Abandoned Leads list counts, so a dashboard number always equals the list total behind it.

export interface DistributionTelecaller {
  userId: string;
  name: string;
  /** Currently assigned to this telecaller (all time). */
  totalAssigned: number;
  /** Currently assigned AND abandoned inside the selected period. */
  inPeriod: number;
  /** Currently assigned AND abandoned today / yesterday (IST), whatever period is selected. */
  todayAbandoned: number;
  yesterdayAbandoned: number;
  /** Currently assigned and whose current assignment was made today / inside the selected period (by ASSIGNMENT time). */
  assignedToday: number;
  assignedInPeriod: number;
}

export interface Distribution {
  range: AbandonmentDateRange;
  timezone: "IST (UTC+05:30)";
  summary: {
    /** Abandoned checkouts in the selected period (inside the viewer's scope). */
    total: number;
    assigned: number;
    unassigned: number;
    telecallersWithLeads: number;
    todayTotal: number;
    yesterdayTotal: number;
    /** No-telecaller checkouts, all time - the standing distribution backlog. */
    unassignedAllTime: number;
  };
  telecallers: DistributionTelecaller[];
}

export interface TelecallerSummary {
  timezone: "IST (UTC+05:30)";
  totalAssigned: number;
  today: number;
  yesterday: number;
  all: number;
  /** Current assignments made today (by assignment time). */
  newlyAssignedToday: number;
}

interface CountRow { ownerId: string | null; total: number; inPeriod: number; today: number; yesterday: number }
interface AssignRow { userId: string; assignedToday: number; assignedInPeriod: number }

/** The viewer's scope as SQL - the same rule AbandonmentService.scopeWhere applies to lists (admin/HR: every abandoned lead; manager: leads assigned to them; telecaller: own). */
function scopeSql(user: AuthUser): Prisma.Sql {
  if (user.role === Role.MANAGER) return Prisma.sql`AND l.assigned_manager_id = ${user.id}::uuid`;
  if (user.role === Role.SALESPERSON) return Prisma.sql`AND l.owner_id = ${user.id}::uuid`;
  if (user.role === Role.ADMIN || user.role === Role.HR) return Prisma.empty;
  return Prisma.sql`AND false`; // any other role: nothing
}

const between = (col: Prisma.Sql, b: { gte: Date; lt: Date } | null) => (b ? Prisma.sql`(${col} >= ${b.gte} AND ${col} < ${b.lt})` : Prisma.sql`true`);

async function countsByOwner(db: DbClient, user: AuthUser, range: AbandonmentDateRange, now: Date): Promise<CountRow[]> {
  const period = abandonmentDateRangeBounds(range, now);
  const today = abandonmentDateRangeBounds("today", now)!;
  const yesterday = abandonmentDateRangeBounds("yesterday", now)!;
  return db.$queryRaw<CountRow[]>`
    SELECT l.owner_id AS "ownerId",
           COUNT(*)::int AS total,
           (COUNT(*) FILTER (WHERE ${between(Prisma.sql`a.detected_at`, period)}))::int AS "inPeriod",
           (COUNT(*) FILTER (WHERE ${between(Prisma.sql`a.detected_at`, today)}))::int AS today,
           (COUNT(*) FILTER (WHERE ${between(Prisma.sql`a.detected_at`, yesterday)}))::int AS yesterday
    FROM abandonments a
    JOIN leads l ON l.id = a.lead_id
    WHERE true ${scopeSql(user)}
    GROUP BY l.owner_id`;
}

async function assignmentsByUser(db: DbClient, user: AuthUser, range: AbandonmentDateRange, now: Date): Promise<AssignRow[]> {
  const period = abandonmentDateRangeBounds(range, now);
  const today = abandonmentDateRangeBounds("today", now)!;
  return db.$queryRaw<AssignRow[]>`
    SELECT la.user_id AS "userId",
           (COUNT(DISTINCT a.id) FILTER (WHERE ${between(Prisma.sql`la.assigned_at`, today)}))::int AS "assignedToday",
           (COUNT(DISTINCT a.id) FILTER (WHERE ${between(Prisma.sql`la.assigned_at`, period)}))::int AS "assignedInPeriod"
    FROM abandonments a
    JOIN leads l ON l.id = a.lead_id
    JOIN lead_assignments la ON la.lead_id = l.id AND la.is_current = true AND la.user_id = l.owner_id
    WHERE true ${scopeSql(user)}
    GROUP BY la.user_id`;
}

/** The telecallers a viewer can see in the breakdown: admin/HR - every active telecaller; manager - their team; (always plus anyone who actually holds leads in scope, so totals reconcile). */
export async function listTelecallers(db: DbClient, user: AuthUser): Promise<{ id: string; name: string }[]> {
  if (user.role === Role.ADMIN || user.role === Role.HR) {
    return db.user.findMany({ where: { role: Role.SALESPERSON, status: UserStatus.ACTIVE }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  }
  if (user.role === Role.MANAGER) {
    const team = await getManagerTeam(user.id, db);
    const reporting = await db.user.findMany({ where: { reportingManagerId: user.id, role: Role.SALESPERSON, status: UserStatus.ACTIVE }, select: { id: true, name: true } });
    const byId = new Map<string, { id: string; name: string }>();
    for (const m of [...team.members, ...reporting]) byId.set(m.id, m);
    const ids = [...byId.keys()];
    if (ids.length === 0) return [];
    const active = await db.user.findMany({ where: { id: { in: ids }, role: Role.SALESPERSON, status: UserStatus.ACTIVE }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    return active;
  }
  return []; // a telecaller never gets a list of other telecallers
}

export async function getDistribution(db: DbClient, user: AuthUser, range: AbandonmentDateRange, now: Date = new Date()): Promise<Distribution> {
  if (user.role === Role.SALESPERSON) throw Object.assign(new Error("Telecallers cannot view the team distribution"), { statusCode: 403 });
  const [rows, assigns, people] = await Promise.all([countsByOwner(db, user, range, now), assignmentsByUser(db, user, range, now), listTelecallers(db, user)]);

  const byOwner = new Map(rows.filter((r) => r.ownerId).map((r) => [r.ownerId!, r]));
  const assignBy = new Map(assigns.map((r) => [r.userId, r]));
  // Anyone holding leads in scope is listed even if not in the visible team (e.g. inactive, or assigned by an admin), so the table adds up to the cards.
  const missing = [...byOwner.keys()].filter((id) => !people.some((p) => p.id === id));
  const extra = missing.length ? await db.user.findMany({ where: { id: { in: missing } }, select: { id: true, name: true } }) : [];
  const telecallers: DistributionTelecaller[] = [...people, ...extra].map((p) => {
    const c = byOwner.get(p.id);
    const a = assignBy.get(p.id);
    return { userId: p.id, name: p.name, totalAssigned: c?.total ?? 0, inPeriod: c?.inPeriod ?? 0, todayAbandoned: c?.today ?? 0, yesterdayAbandoned: c?.yesterday ?? 0, assignedToday: a?.assignedToday ?? 0, assignedInPeriod: a?.assignedInPeriod ?? 0 };
  });
  telecallers.sort((a, b) => b.totalAssigned - a.totalAssigned || a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));

  const sum = (f: (r: CountRow) => number, only?: (r: CountRow) => boolean) => rows.filter((r) => (only ? only(r) : true)).reduce((s, r) => s + f(r), 0);
  const unassignedRows = (r: CountRow) => r.ownerId === null;
  return {
    range,
    timezone: "IST (UTC+05:30)",
    summary: {
      total: sum((r) => r.inPeriod),
      assigned: sum((r) => r.inPeriod, (r) => !unassignedRows(r)),
      unassigned: sum((r) => r.inPeriod, unassignedRows),
      telecallersWithLeads: rows.filter((r) => r.ownerId && r.inPeriod > 0).length,
      todayTotal: sum((r) => r.today),
      yesterdayTotal: sum((r) => r.yesterday),
      unassignedAllTime: sum((r) => r.total, unassignedRows),
    },
    telecallers,
  };
}

/** A telecaller's OWN workload only - derived from the authenticated user, never from a client-supplied id. Unassigned leads are never part of it. */
export async function getTelecallerSummary(db: DbClient, user: AuthUser, now: Date = new Date()): Promise<TelecallerSummary> {
  if (user.role !== Role.SALESPERSON) throw Object.assign(new Error("Only telecallers have a personal lead summary"), { statusCode: 403 });
  const [rows, assigns] = await Promise.all([countsByOwner(db, user, "all", now), assignmentsByUser(db, user, "all", now)]);
  const mine = rows.find((r) => r.ownerId === user.id);
  return { timezone: "IST (UTC+05:30)", totalAssigned: mine?.total ?? 0, today: mine?.today ?? 0, yesterday: mine?.yesterday ?? 0, all: mine?.total ?? 0, newlyAssignedToday: assigns.find((a) => a.userId === user.id)?.assignedToday ?? 0 };
}
