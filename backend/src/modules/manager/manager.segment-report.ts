import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { CallStatus, LeadWorkingStatus, LifecycleStage, Role, TaskStatus, TaskType } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { safeCell } from "../report-automation/report-automation.xlsx.js";
import { classify, type CallStatusFilter } from "./manager.metrics.js";
import { leadListEligibility, leadListScope, NOT_IN_LEAD_LIST } from "../lead/lead.listing.js";
import type { AnalyticsFilters, AnalyticsViewer } from "./manager.analytics.js";

// SEGMENT LEAD REPORT. The members of one campaign segment (Segment + LeadSegment - the same segments the Leads section uses, built-in and custom) with their LEAD ACTIVITY. Read-only.
// A lead is never treated as an order: nothing here counts or adds up sales (the Reports' Sales section does that, narrowed to the same segment by manager.sales.ts).
//
//  Who is in it   EXACTLY the segment's members the Lead section lists (lead/lead.listing.ts, shared with it): lead stage, no abandoned-cart records. ADMIN: all; MANAGER: leads assigned to them; others: refused.
//  Excluded       members the Lead section leaves out (converted to customer, or from an abandoned cart) are never in a total, metric or row above. They are reported SEPARATELY, with their own counts,
//                 list, history and Excel sheets. They can be second records of a person who is also in the main list.
//  Salesperson    leads currently assigned to that salesperson.
//  Date range     applies to ACTIVITY (calls, recorded activities, completed follow-ups) and to "added in this period" - membership itself is not dated, so the lead list is not cut by date.
//  Call status    when not "All", only leads with at least one such call in the period are listed, and only those calls are counted.
//  Lead metrics   the lead's CURRENT state:  Pending = status New / Assigned, never called, never marked contacted.  Contacted = every other lead (so Total = Contacted + Pending).
//                 Converted = status Converted.  Lost = status Not Interested or DND.
//  Follow-ups     tasks of type Follow-up or Callback.  Completed = completed inside the period.  Pending = still open now (whatever the period); overdue = open and past its time.

export const LOST_STATUSES: LeadWorkingStatus[] = [LeadWorkingStatus.NOT_INTERESTED, LeadWorkingStatus.DND];
export const FOLLOW_UP_TYPES: TaskType[] = [TaskType.FOLLOW_UP, TaskType.CALLBACK];
const OPEN_TASKS: TaskStatus[] = [TaskStatus.PENDING, TaskStatus.OVERDUE];
export const MAX_PAGE_SIZE = 100;
export const MAX_EXPORT_LEADS = 20_000;
export const MAX_EXPORT_ROWS = 100_000;
const HISTORY_LIMIT = 200;
const CHUNK = 1_000;
const DAY_MS = 86_400_000;

export interface SegmentReportQuery extends AnalyticsFilters {
  segmentId?: string;
}
type Db = typeof prisma;

export function periodOf(f: Pick<AnalyticsFilters, "from" | "to" | "tzOffsetMinutes">): { start: Date; end: Date } {
  const at = (d: string) => Date.parse(`${d}T00:00:00.000Z`) - f.tzOffsetMinutes * 60_000;
  return { start: new Date(at(f.from)), end: new Date(at(f.to) + DAY_MS) };
}

export const callStatusesFor = (filter: CallStatusFilter): CallStatus[] | null => {
  if (filter === "ALL") return null;
  const kind = filter === "CONNECTED" ? "connected" : filter === "FAILED" ? "failed" : "notConnected";
  return Object.values(CallStatus).filter((s) => classify(s) === kind);
};

/** Calls of the period (by start time; by creation when a call never started), narrowed by the call-status filter. */
export function callsInPeriod(f: AnalyticsFilters): Prisma.CallWhereInput {
  const { start, end } = periodOf(f);
  const statuses = callStatusesFor(f.callStatus);
  return {
    OR: [{ startedAt: { gte: start, lt: end } }, { startedAt: null, createdAt: { gte: start, lt: end } }],
    ...(statuses ? { status: { in: statuses } } : {}),
  };
}

/** "listed" = what the Lead section lists (the report itself); "excluded" = the members it leaves out; "member" = both (only to decide whether one record's history may be read). */
export type SegmentPopulation = "listed" | "excluded" | "member";

/** WHICH leads the report is about. Every number, row and export is built from this one condition, so they cannot disagree. */
export function segmentLeadWhere(viewer: AnalyticsViewer, f: SegmentReportQuery, population: SegmentPopulation = "listed"): Prisma.LeadWhereInput {
  if (viewer.role !== Role.ADMIN && viewer.role !== Role.MANAGER) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
  if (!f.segmentId) throw new ApiError("segmentId is required", STATUS_CODES.BAD_REQUEST);
  return {
    ...leadListScope(viewer),
    segments: { some: { segmentId: f.segmentId } },
    ...(population === "listed" ? leadListEligibility() : population === "excluded" ? NOT_IN_LEAD_LIST : {}),
    ...(f.salespersonId ? { ownerId: f.salespersonId } : {}),
    ...(f.callStatus !== "ALL" ? { calls: { some: callsInPeriod(f) } } : {}),
  };
}

const PENDING_CONDITION: Prisma.LeadWhereInput = {
  workingStatus: { in: [LeadWorkingStatus.NEW, LeadWorkingStatus.ASSIGNED] },
  lastContactedAt: null,
  calls: { none: {} },
};

const LEAD_SELECT = {
  id: true,
  leadNumber: true,
  firstName: true,
  lastName: true,
  mobile: true,
  email: true,
  location: true,
  workingStatus: true,
  priority: true,
  lifecycleStage: true,
  customerClass: true,
  createdAt: true,
  lastContactedAt: true,
  lastActivityAt: true,
  owner: { select: { name: true } },
  assignedManager: { select: { name: true } },
  source: { select: { name: true } },
} satisfies Prisma.LeadSelect;
type LeadRecord = Prisma.LeadGetPayload<{ select: typeof LEAD_SELECT }>;

export interface SegmentLeadRow {
  id: string;
  leadNumber: string;
  name: string;
  phone: string | null;
  email: string | null;
  location: string | null;
  salesperson: string | null;
  manager: string | null;
  source: string | null;
  status: LeadWorkingStatus;
  priority: string;
  stage: string;
  createdAt: Date;
  lastContactedAt: Date | null;
  lastActivityAt: Date | null;
  /** In the period. */
  calls: number;
  connectedCalls: number;
  activities: number;
  notes: number;
  followUpsCompleted: number;
  /** Open now. */
  followUpsPending: number;
}

class SegmentReportService {
  constructor(
    private readonly db: Db = prisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async segmentOrThrow(id: string | undefined) {
    const segment = id ? await this.db.segment.findUnique({ where: { id }, select: { id: true, name: true, color: true, isSystem: true, isActive: true } }) : null;
    if (!segment) throw new ApiError("Segment not found", STATUS_CODES.NOT_FOUND);
    return segment;
  }

  private async metrics(where: Prisma.LeadWhereInput, f: SegmentReportQuery) {
    const { start, end } = periodOf(f);
    const period = { gte: start, lt: end };
    const and = (extra: Prisma.LeadWhereInput): Prisma.LeadWhereInput => ({ AND: [where, extra] });
    const followUp = { type: { in: FOLLOW_UP_TYPES }, lead: where };
    const [total, pending, converted, lost, addedInPeriod, callGroups, activityGroups, done, open, overdue] = await Promise.all([
      this.db.lead.count({ where }),
      this.db.lead.count({ where: and(PENDING_CONDITION) }),
      this.db.lead.count({ where: and({ workingStatus: LeadWorkingStatus.CONVERTED }) }),
      this.db.lead.count({ where: and({ workingStatus: { in: LOST_STATUSES } }) }),
      this.db.lead.count({ where: and({ createdAt: period }) }),
      this.db.call.groupBy({ by: ["status"], where: { ...callsInPeriod(f), lead: where }, _count: { _all: true } }),
      this.db.activity.groupBy({ by: ["type"], where: { createdAt: period, lead: where }, _count: { _all: true } }),
      this.db.task.count({ where: { ...followUp, status: TaskStatus.COMPLETED, completedAt: period } }),
      this.db.task.count({ where: { ...followUp, status: { in: OPEN_TASKS } } }),
      this.db.task.count({ where: { ...followUp, status: { in: OPEN_TASKS }, scheduledAt: { lt: this.now() } } }),
    ]);
    const calls = callGroups.reduce((n, g) => n + g._count._all, 0);
    const connectedCalls = callGroups.reduce((n, g) => n + (classify(g.status) === "connected" ? g._count._all : 0), 0);
    const byType = activityGroups.map((g) => ({ type: g.type, count: g._count._all })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    const typed = (...types: string[]) => byType.filter((a) => types.includes(a.type)).reduce((n, a) => n + a.count, 0);
    return {
      totalLeads: total,
      contacted: total - pending,
      pending,
      converted,
      lost,
      addedInPeriod,
      calls,
      connectedCalls,
      followUpsCompleted: done,
      followUpsPending: open,
      followUpsOverdue: overdue,
      activities: byType.reduce((n, a) => n + a.count, 0),
      notes: typed("NOTE"),
      statusChanges: typed("STATUS_CHANGE"),
      assignments: typed("ASSIGNMENT", "REASSIGNMENT"),
      activityByType: byType,
    };
  }

  /** The members the Lead section leaves out, by reason and current status. The two reasons never overlap: a converted customer is counted as a customer even when it also came from an abandoned cart. */
  private async excludedSummary(where: Prisma.LeadWhereInput, f: SegmentReportQuery) {
    const { start, end } = periodOf(f);
    const period = { gte: start, lt: end };
    const and = (extra: Prisma.LeadWhereInput): Prisma.LeadWhereInput => ({ AND: [where, extra] });
    const [total, customers, customersFromCart, statuses, calls, activities] = await Promise.all([
      this.db.lead.count({ where }),
      this.db.lead.count({ where: and({ lifecycleStage: { not: LifecycleStage.LEAD } }) }),
      this.db.lead.count({ where: and({ lifecycleStage: { not: LifecycleStage.LEAD }, abandonments: { some: {} } }) }),
      this.db.lead.groupBy({ by: ["workingStatus"], where, _count: { _all: true } }),
      this.db.call.count({ where: { ...callsInPeriod(f), lead: where } }),
      this.db.activity.count({ where: { createdAt: period, lead: where } }),
    ]);
    return {
      total,
      customers,
      customersFromAbandonedCart: customersFromCart,
      abandonedCart: total - customers,
      byStatus: statuses.map((g) => ({ status: g.workingStatus, count: g._count._all })).sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
      calls,
      activities,
    };
  }

  /** The listed leads with their per-lead activity counts: grouped queries for the whole batch, never one query per lead. */
  private async rows(leads: LeadRecord[], f: SegmentReportQuery): Promise<SegmentLeadRow[]> {
    if (leads.length === 0) return [];
    const { start, end } = periodOf(f);
    const period = { gte: start, lt: end };
    const ids = leads.map((l) => l.id);
    const [calls, activities, done, open] = await Promise.all([
      this.db.call.groupBy({ by: ["leadId", "status"], where: { ...callsInPeriod(f), leadId: { in: ids } }, _count: { _all: true } }),
      this.db.activity.groupBy({ by: ["leadId", "type"], where: { createdAt: period, leadId: { in: ids } }, _count: { _all: true } }),
      this.db.task.groupBy({ by: ["leadId"], where: { leadId: { in: ids }, type: { in: FOLLOW_UP_TYPES }, status: TaskStatus.COMPLETED, completedAt: period }, _count: { _all: true } }),
      this.db.task.groupBy({ by: ["leadId"], where: { leadId: { in: ids }, type: { in: FOLLOW_UP_TYPES }, status: { in: OPEN_TASKS } }, _count: { _all: true } }),
    ]);
    const tally = new Map(ids.map((id) => [id, { calls: 0, connectedCalls: 0, activities: 0, notes: 0, followUpsCompleted: 0, followUpsPending: 0 }]));
    for (const c of calls) {
      const t = tally.get(c.leadId!);
      if (!t) continue;
      t.calls += c._count._all;
      if (classify(c.status) === "connected") t.connectedCalls += c._count._all;
    }
    for (const a of activities) {
      const t = tally.get(a.leadId!);
      if (!t) continue;
      t.activities += a._count._all;
      if (a.type === "NOTE") t.notes += a._count._all;
    }
    for (const d of done) tally.get(d.leadId)!.followUpsCompleted = d._count._all;
    for (const o of open) tally.get(o.leadId)!.followUpsPending = o._count._all;
    return leads.map((l) => ({
      id: l.id,
      leadNumber: l.leadNumber,
      name: [l.firstName, l.lastName].filter(Boolean).join(" "),
      phone: l.mobile,
      email: l.email,
      location: l.location,
      salesperson: l.owner?.name ?? null,
      manager: l.assignedManager?.name ?? null,
      source: l.source?.name ?? null,
      status: l.workingStatus,
      priority: l.priority,
      stage: l.lifecycleStage,
      createdAt: l.createdAt,
      lastContactedAt: l.lastContactedAt,
      lastActivityAt: l.lastActivityAt,
      ...tally.get(l.id)!,
    }));
  }

  /** `view` picks which records are LISTED and paged; the metrics are always those of the Lead-section records, and `excluded` always describes the others. */
  async report(viewer: AnalyticsViewer, f: SegmentReportQuery, page: number, pageSize: number, view: "listed" | "excluded" = "listed") {
    const where = segmentLeadWhere(viewer, f);
    const excludedWhere = segmentLeadWhere(viewer, f, "excluded");
    const segment = await this.segmentOrThrow(f.segmentId);
    const size = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
    const [metrics, excluded, leads] = await Promise.all([
      this.metrics(where, f),
      this.excludedSummary(excludedWhere, f),
      // the same order as the Lead section (id breaks ties between rows created in one import chunk)
      this.db.lead.findMany({ where: view === "excluded" ? excludedWhere : where, select: LEAD_SELECT, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (Math.max(1, page) - 1) * size, take: size }),
    ]);
    const total = view === "excluded" ? excluded.total : metrics.totalLeads;
    return {
      segment,
      range: { from: f.from, to: f.to },
      view,
      metrics,
      excluded,
      leads: await this.rows(leads, f),
      pagination: { page: Math.max(1, page), pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) },
    };
  }

  /** One lead's whole history (not cut by the date range), newest first. Only for a lead that is in this viewer's view of the segment. */
  async history(viewer: AnalyticsViewer, f: SegmentReportQuery, leadId: string) {
    // the salesperson / call-status filters pick which leads are listed; they do not decide who may read a listed lead's history
    // Excluded records keep their history too, so it is read from the whole membership (still only what this viewer may see).
    const where = segmentLeadWhere(viewer, { ...f, salespersonId: undefined, callStatus: "ALL" }, "member");
    const lead = await this.db.lead.findFirst({ where: { AND: [{ id: leadId }, where] }, select: LEAD_SELECT });
    if (!lead) throw new ApiError("Lead not found", STATUS_CODES.NOT_FOUND);
    const [activities, calls, tasks] = await Promise.all([
      this.db.activity.findMany({ where: { leadId }, select: { id: true, type: true, title: true, description: true, createdAt: true, actor: { select: { name: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: HISTORY_LIMIT }),
      this.db.call.findMany({ where: { leadId }, select: { id: true, status: true, direction: true, durationSeconds: true, notes: true, startedAt: true, createdAt: true, agent: { select: { name: true } }, outcome: { select: { name: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: HISTORY_LIMIT }),
      this.db.task.findMany({ where: { leadId }, select: { id: true, type: true, status: true, title: true, description: true, scheduledAt: true, completedAt: true, createdAt: true, assignedTo: { select: { name: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: HISTORY_LIMIT }),
    ]);
    return {
      lead: { id: lead.id, leadNumber: lead.leadNumber, name: [lead.firstName, lead.lastName].filter(Boolean).join(" "), phone: lead.mobile, status: lead.workingStatus, salesperson: lead.owner?.name ?? null },
      activities: activities.map(({ actor, ...a }) => ({ ...a, by: actor?.name ?? null })),
      calls: calls.map(({ agent, outcome, ...c }) => ({ ...c, by: agent?.name ?? null, outcome: outcome?.name ?? null })),
      tasks: tasks.map(({ assignedTo, ...t }) => ({ ...t, assignedTo: assignedTo?.name ?? null })),
      limit: HISTORY_LIMIT,
    };
  }

  /** Every record matching `where` with its calls, follow-ups and activities for the period. */
  private async collect(where: Prisma.LeadWhereInput, f: SegmentReportQuery) {
    const leads: LeadRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.db.lead.findMany({ where, select: LEAD_SELECT, orderBy: { id: "asc" }, take: CHUNK, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) });
      leads.push(...batch);
      if (batch.length < CHUNK) break;
      cursor = batch[batch.length - 1]!.id;
    }
    leads.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
    const rows: SegmentLeadRow[] = [];
    for (let i = 0; i < leads.length; i += CHUNK) rows.push(...(await this.rows(leads.slice(i, i + CHUNK), f)));

    const { start, end } = periodOf(f);
    const period = { gte: start, lt: end };
    const activities: { leadId: string | null; type: string; title: string | null; description: string | null; createdAt: Date; actor: { name: string } | null }[] = [];
    const calls: { leadId: string | null; status: CallStatus; direction: string; durationSeconds: number | null; notes: string | null; startedAt: Date | null; createdAt: Date; agent: { name: string } | null }[] = [];
    const tasks: { leadId: string; type: TaskType; status: TaskStatus; title: string; scheduledAt: Date | null; completedAt: Date | null; assignedTo: { name: string } | null }[] = [];
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += CHUNK) {
      const leadId = { in: ids.slice(i, i + CHUNK) };
      const [a, c, t] = await Promise.all([
        this.db.activity.findMany({ where: { leadId, createdAt: period }, select: { leadId: true, type: true, title: true, description: true, createdAt: true, actor: { select: { name: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
        this.db.call.findMany({ where: { ...callsInPeriod(f), leadId }, select: { leadId: true, status: true, direction: true, durationSeconds: true, notes: true, startedAt: true, createdAt: true, agent: { select: { name: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
        this.db.task.findMany({ where: { leadId, type: { in: FOLLOW_UP_TYPES }, OR: [{ status: { in: OPEN_TASKS } }, { status: TaskStatus.COMPLETED, completedAt: period }] }, select: { leadId: true, type: true, status: true, title: true, scheduledAt: true, completedAt: true, assignedTo: { select: { name: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      ]);
      activities.push(...a);
      calls.push(...c);
      tasks.push(...t);
    }
    return { rows, activities, calls, tasks };
  }

  /** The whole filtered segment as an Excel workbook: the Lead-section records in Leads / Calls / Follow-ups / Activity, the excluded ones in their own "Excluded ..." sheets. Too large -> refused with a reason; a file is never silently cut short. */
  async exportXlsx(viewer: AnalyticsViewer, f: SegmentReportQuery, salespersonName: string | null = null): Promise<{ buffer: Buffer; filename: string }> {
    const where = segmentLeadWhere(viewer, f);
    const excludedWhere = segmentLeadWhere(viewer, f, "excluded");
    const segment = await this.segmentOrThrow(f.segmentId);
    const [metrics, excluded] = await Promise.all([this.metrics(where, f), this.excludedSummary(excludedWhere, f)]);
    const openFollowUps = metrics.followUpsPending + metrics.followUpsCompleted;
    if (metrics.totalLeads + excluded.total > MAX_EXPORT_LEADS || metrics.activities + excluded.activities > MAX_EXPORT_ROWS || metrics.calls + excluded.calls > MAX_EXPORT_ROWS || openFollowUps > MAX_EXPORT_ROWS) {
      throw new ApiError(`This export is too large (limit ${MAX_EXPORT_LEADS.toLocaleString("en-IN")} leads and ${MAX_EXPORT_ROWS.toLocaleString("en-IN")} rows per sheet). Choose a salesperson or a shorter date range.`, 422);
    }
    const main = await this.collect(where, f);
    const others = await this.collect(excludedWhere, f);

    const stamp = (d: Date | null) => (d ? new Date(d.getTime() + f.tzOffsetMinutes * 60_000).toISOString().slice(0, 16).replace("T", " ") : "");
    const text = (v: string | null | undefined) => safeCell(v ?? "");
    const book = new ExcelJS.Workbook();
    const sheet = (name: string, header: string[], data: (string | number)[][]) => {
      const s = book.addWorksheet(name);
      s.addRow(header).font = { bold: true };
      for (const r of data) s.addRow(r);
      s.views = [{ state: "frozen", ySplit: 1 }];
      s.columns.forEach((col, i) => (col.width = Math.min(60, Math.max(14, header[i]!.length + 2))));
    };
    sheet("Summary", ["Item", "Value"], [
      ["Segment", text(segment.name)],
      ["Activity period (IST)", `${f.from} to ${f.to}`],
      ["Salesperson", f.salespersonId ? text(salespersonName ?? "Selected salesperson") : "All salespeople"],
      ["Call status filter", f.callStatus],
      ["Total leads (as in the Leads section)", metrics.totalLeads],
      ["Contacted", metrics.contacted],
      ["Pending (not contacted)", metrics.pending],
      ["Converted", metrics.converted],
      ["Lost (Not Interested / DND)", metrics.lost],
      ["Added in period", metrics.addedInPeriod],
      ["Calls in period", metrics.calls],
      ["Connected calls in period", metrics.connectedCalls],
      ["Follow-ups completed in period", metrics.followUpsCompleted],
      ["Follow-ups pending now", metrics.followUpsPending],
      ["Follow-ups overdue now", metrics.followUpsOverdue],
      ["Recorded activities in period", metrics.activities],
      ...metrics.activityByType.map((a): [string, number] => [`Activity: ${a.type}`, a.count]),
      ["Excluded records (not in the totals above)", excluded.total],
      ["Excluded: converted to customer", excluded.customers],
      ["Excluded: of those customers, also from an abandoned cart", excluded.customersFromAbandonedCart],
      ["Excluded: abandoned cart (not a customer)", excluded.abandonedCart],
      ...excluded.byStatus.map((s): [string, number] => [`Excluded with status ${s.status}`, s.count]),
    ]);
    const leadHeader = ["Lead number", "Name", "Phone", "Email", "Location", "Salesperson", "Manager", "Source", "Lead status", "Priority", "Stage", "Created (IST)", "Last contacted (IST)", "Last activity (IST)", "Calls in period", "Connected calls", "Activities in period", "Notes in period", "Follow-ups completed", "Follow-ups pending"];
    const leadCells = (r: SegmentLeadRow): (string | number)[] => [text(r.leadNumber), text(r.name), text(r.phone), text(r.email), text(r.location), text(r.salesperson), text(r.manager), text(r.source), r.status, r.priority, r.stage, stamp(r.createdAt), stamp(r.lastContactedAt), stamp(r.lastActivityAt), r.calls, r.connectedCalls, r.activities, r.notes, r.followUpsCompleted, r.followUpsPending];
    const detail = (prefix: string, set: typeof main) => {
      const who = new Map(set.rows.map((r) => [r.id, r]));
      const idCells = (leadId: string | null) => [text(who.get(leadId ?? "")?.leadNumber), text(who.get(leadId ?? "")?.name), text(who.get(leadId ?? "")?.phone)];
      sheet(`${prefix}Calls`, ["Lead number", "Name", "Phone", "When (IST)", "Direction", "Call status", "Duration (s)", "Agent", "Call notes"],
        set.calls.map((c) => [...idCells(c.leadId), stamp(c.startedAt ?? c.createdAt), c.direction, c.status, c.durationSeconds ?? "", text(c.agent?.name), text(c.notes)]));
      sheet(`${prefix}Follow-ups`, ["Lead number", "Name", "Phone", "Type", "Status", "Title", "Scheduled (IST)", "Completed (IST)", "Assigned to"],
        set.tasks.map((t) => [...idCells(t.leadId), t.type, t.status, text(t.title), stamp(t.scheduledAt), stamp(t.completedAt), text(t.assignedTo?.name)]));
      sheet(`${prefix}Activity`, ["Lead number", "Name", "Phone", "When (IST)", "Type", "Title", "Details", "By"],
        set.activities.map((a) => [...idCells(a.leadId), stamp(a.createdAt), a.type, text(a.title), text(a.description), text(a.actor?.name)]));
    };
    sheet("Leads", leadHeader, main.rows.map(leadCells));
    detail("", main);
    sheet("Excluded records", ["Why excluded", ...leadHeader], others.rows.map((r) => [r.stage === "CUSTOMER" ? "Converted to customer" : "Abandoned cart", ...leadCells(r)]));
    detail("Excluded ", others);

    const slug = segment.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "segment";
    return { buffer: Buffer.from(await book.xlsx.writeBuffer()), filename: `segment-${slug}-${f.from}_${f.to}.xlsx` };
  }
}

export const segmentReportService = new SegmentReportService();
export { SegmentReportService };
