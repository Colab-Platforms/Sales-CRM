import { prisma } from "@/lib/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { CallStatus, LeadWorkingStatus } from "../../../generated/prisma/enums.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { todayString } from "../attendance/attendance.calc.js";
import { REPORT_TZ_OFFSET_MINUTES } from "../attendance/attendance.constants.js";
import { abandonmentLeadScope, canAccessRecordings } from "./abandonment.filters.js";
import { abandonmentItemsWhere, parseItemKeys, readSnapshotItems } from "./abandonment.items.js";
import { isUsableRecording, recordingRangeBounds } from "./abandonment.recordings.js";

// The centralised "Call Recordings" screen of the Abandoned Leads module (admin / manager only). It reads the CallRecording rows the calling integration already writes
// (one per call, `call_id` is unique, so a recording can never be listed twice) for calls made to leads that have an abandoned checkout, and shows the telecaller who
// ACTUALLY made the call (calls.agent_id) - never the person the lead is assigned to today. Nothing is stored or duplicated here.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OUTCOME_TOKEN = /^(outcome:[0-9a-f-]{36}|status:[A-Z_]+)$/;
export const MAX_SELECTED_RECORDINGS = 2000;
const MAX_PAGE_SIZE = 100;
/** Call states that can never carry a recording worth listing as a filter choice. */
const HIDDEN_STATUSES = new Set<string>([CallStatus.INITIATED, CallStatus.RINGING_AGENT, CallStatus.RINGING_CUSTOMER]);

export interface CallRecordingFilters {
  from: string; // IST day, inclusive
  to: string; // IST day, inclusive
  telecallerIds?: string[];
  customer?: string;
  mobile?: string;
  /** Item keys (see abandonment.items.ts): any of these products is in the lead's abandoned cart. */
  items?: string[];
  statuses?: LeadWorkingStatus[];
  /** "outcome:<uuid>" (the outcome the telecaller chose) or "status:<CALL_STATUS>" (no outcome chosen; the call's own result). */
  outcomes?: string[];
  minDuration?: number;
  maxDuration?: number;
  leadId?: string;
  /** Exactly these calls (ticked rows). Replaces every other filter. */
  callIds?: string[];
  sort?: "latest" | "oldest";
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : typeof v === "string" && v.trim() ? v.split(",") : []).map((s) => s.trim()).filter(Boolean);
const asText = (v: unknown, max = 100): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const asSeconds = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 86_400) throw new ApiError(`${name} must be a number of seconds`, STATUS_CODES.BAD_REQUEST);
  return Math.floor(n);
};

/** Validates (never trusts) the filters from a query string or an export body. A bad value is a clear 400. */
export function parseCallRecordingFilters(raw: Record<string, unknown>): CallRecordingFilters {
  const from = typeof raw.from === "string" ? raw.from : "";
  const to = typeof raw.to === "string" ? raw.to : "";
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new ApiError("from and to must be dates (YYYY-MM-DD)", STATUS_CODES.BAD_REQUEST);
  recordingRangeBounds({ from, to }); // order + validity
  const out: CallRecordingFilters = { from, to };

  const telecallerIds = asList(raw.telecallerIds);
  if (telecallerIds.length > 0) {
    if (telecallerIds.length > 200 || telecallerIds.some((id) => !UUID.test(id))) throw new ApiError("Invalid telecaller filter", STATUS_CODES.BAD_REQUEST);
    out.telecallerIds = [...new Set(telecallerIds)];
  }
  out.customer = asText(raw.customer);
  out.mobile = asText(raw.mobile, 30);
  if (typeof raw.items === "string" && raw.items.trim()) {
    const keys = parseItemKeys(raw.items);
    if (!keys) throw new ApiError("Invalid product filter", STATUS_CODES.BAD_REQUEST);
    if (keys.length > 0) out.items = keys;
  }
  const statuses = asList(raw.statuses);
  if (statuses.length > 0) {
    const valid = new Set<string>(Object.values(LeadWorkingStatus));
    if (statuses.some((s) => !valid.has(s))) throw new ApiError("Invalid lead status filter", STATUS_CODES.BAD_REQUEST);
    out.statuses = [...new Set(statuses)] as LeadWorkingStatus[];
  }
  const outcomes = asList(raw.outcomes);
  if (outcomes.length > 0) {
    if (outcomes.length > 50 || outcomes.some((o) => !OUTCOME_TOKEN.test(o))) throw new ApiError("Invalid call outcome filter", STATUS_CODES.BAD_REQUEST);
    out.outcomes = [...new Set(outcomes)];
  }
  out.minDuration = asSeconds(raw.minDuration, "minDuration");
  out.maxDuration = asSeconds(raw.maxDuration, "maxDuration");
  if (out.minDuration !== undefined && out.maxDuration !== undefined && out.minDuration > out.maxDuration) throw new ApiError("minDuration must not be above maxDuration", STATUS_CODES.BAD_REQUEST);
  if (raw.leadId !== undefined && raw.leadId !== "") {
    if (typeof raw.leadId !== "string" || !UUID.test(raw.leadId)) throw new ApiError("Invalid lead", STATUS_CODES.BAD_REQUEST);
    out.leadId = raw.leadId;
  }
  const callIds = asList(raw.callIds);
  if (callIds.length > 0) {
    if (callIds.some((id) => !UUID.test(id))) throw new ApiError("The selected recordings are not valid", STATUS_CODES.BAD_REQUEST);
    const unique = [...new Set(callIds)].sort();
    if (unique.length > MAX_SELECTED_RECORDINGS) throw new ApiError(`${unique.length} recordings selected - at most ${MAX_SELECTED_RECORDINGS} can be exported by selection. Use "all matching" instead.`, STATUS_CODES.BAD_REQUEST);
    out.callIds = unique;
  }
  if (raw.sort === "oldest") out.sort = "oldest";
  else if (raw.sort === "latest") out.sort = "latest";
  for (const key of Object.keys(out) as (keyof CallRecordingFilters)[]) if (out[key] === undefined) delete out[key];
  return out;
}

function dateWhere(range: { from: string; to: string }): Prisma.CallWhereInput {
  const { gte, lt } = recordingRangeBounds(range);
  // The call's own start time (IST day bounds); calls that never got a start time fall back to when their row was created.
  return { OR: [{ startedAt: { gte, lt } }, { startedAt: null, createdAt: { gte, lt } }] };
}

/** The call's length: the call's own duration, else the recording's. */
const durationAtLeast = (s: number): Prisma.CallWhereInput => ({ OR: [{ durationSeconds: { gte: s } }, { durationSeconds: null, recording: { is: { durationSeconds: { gte: s } } } }] });
const durationAtMost = (s: number): Prisma.CallWhereInput => ({ OR: [{ durationSeconds: { lte: s } }, { durationSeconds: null, recording: { is: { durationSeconds: { lte: s } } } }] });

/** The filter conditions only (no permission scope - see scopedWhere). Every filter ANDs with every other. `ignoreDate` is for the "today" card. */
export function buildCallRecordingWhere(f: CallRecordingFilters, options: { range?: { from: string; to: string }; ignoreDate?: boolean } = {}): Prisma.CallWhereInput {
  if (f.callIds && f.callIds.length > 0) return { AND: [{ id: { in: f.callIds } }] };
  const and: Prisma.CallWhereInput[] = [];
  if (!options.ignoreDate) and.push(dateWhere(options.range ?? { from: f.from, to: f.to }));
  if (f.telecallerIds?.length) and.push({ agentId: { in: f.telecallerIds } });
  if (f.leadId) and.push({ leadId: f.leadId });
  if (f.customer) {
    for (const term of f.customer.split(/\s+/).filter(Boolean).slice(0, 5)) {
      const contains = { contains: term, mode: "insensitive" as const };
      and.push({ lead: { OR: [{ firstName: contains }, { lastName: contains }, { leadNumber: contains }] } });
    }
  }
  if (f.mobile) {
    const digits = f.mobile.replace(/\D/g, "");
    if (digits.length > 0) {
      const needle = digits.length > 10 ? digits.slice(-10) : digits;
      and.push({ OR: [{ lead: { mobile: { contains: needle } } }, { customerNumber: { contains: needle } }] });
    }
  }
  if (f.items?.length) and.push({ lead: { abandonments: { some: abandonmentItemsWhere(f.items) } } });
  if (f.statuses?.length) and.push({ lead: { workingStatus: { in: f.statuses } } });
  if (f.outcomes?.length) {
    const outcomeIds = f.outcomes.filter((o) => o.startsWith("outcome:")).map((o) => o.slice(8));
    const statuses = f.outcomes.filter((o) => o.startsWith("status:")).map((o) => o.slice(7) as CallStatus);
    const or: Prisma.CallWhereInput[] = [];
    if (outcomeIds.length) or.push({ outcomeId: { in: outcomeIds } });
    // The same rule the table shows: no chosen outcome -> the call's own result.
    if (statuses.length) or.push({ outcomeId: null, status: { in: statuses } });
    and.push({ OR: or });
  }
  if (f.minDuration !== undefined && f.minDuration > 0) and.push(durationAtLeast(f.minDuration));
  if (f.maxDuration !== undefined) and.push(durationAtMost(f.maxDuration));
  return { AND: and };
}

/** Filters + who may see what: a recording with a link, of a call to a lead with an abandoned checkout inside the viewer's lead scope. */
export function scopedCallRecordingWhere(user: AuthUser, filterWhere: Prisma.CallWhereInput): Prisma.CallWhereInput {
  return { AND: [filterWhere, { recording: { isNot: null } }, { lead: { AND: [abandonmentLeadScope(user), { abandonments: { some: {} } }] } }] };
}

const LIST_ORDER = (sort: "latest" | "oldest" | undefined): Prisma.CallOrderByWithRelationInput[] => {
  const dir = sort === "oldest" ? "asc" : "desc";
  return [{ startedAt: { sort: dir, nulls: "last" } }, { createdAt: dir }, { id: "asc" }];
};

const SELECT = {
  id: true,
  startedAt: true,
  createdAt: true,
  durationSeconds: true,
  status: true,
  agent: { select: { id: true, name: true } },
  outcome: { select: { id: true, name: true } },
  recording: { select: { recordingUrl: true, expiresAt: true, durationSeconds: true } },
  lead: {
    select: {
      id: true,
      leadNumber: true,
      firstName: true,
      lastName: true,
      mobile: true,
      workingStatus: true,
      abandonments: { orderBy: { detectedAt: "desc" as const }, take: 1, select: { id: true, cartSnapshot: true } },
    },
  },
} satisfies Prisma.CallSelect;

type CallRow = Prisma.CallGetPayload<{ select: typeof SELECT }>;

const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function productNames(snapshot: unknown): string[] {
  const s = (snapshot && typeof snapshot === "object" ? snapshot : {}) as Record<string, unknown>;
  const lines = readSnapshotItems(s.items);
  const names = lines.length > 0 ? lines.map((i) => i.name) : Array.isArray(s.itemNames) ? s.itemNames.filter((n): n is string => typeof n === "string") : [];
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}

export interface CallRecordingItem {
  callId: string;
  callAt: Date;
  leadId: string;
  abandonmentId: string | null;
  leadNumber: string;
  customerName: string;
  mobile: string | null;
  telecaller: { id: string; name: string };
  products: string[];
  leadStatus: LeadWorkingStatus;
  outcome: string;
  durationSeconds: number | null;
  /** Direct link the browser plays from; null when the recording cannot be played (no link, expired, not an approved https host). */
  playUrl: string | null;
  unavailableReason: string | null;
}

export function toCallRecordingItem(c: CallRow, now: Date = new Date()): CallRecordingItem {
  const usable = isUsableRecording({ recordingUrl: c.recording?.recordingUrl ?? null, expiresAt: c.recording?.expiresAt ?? null }, now);
  return {
    callId: c.id,
    callAt: c.startedAt ?? c.createdAt,
    leadId: c.lead!.id,
    abandonmentId: c.lead!.abandonments[0]?.id ?? null,
    leadNumber: c.lead!.leadNumber,
    customerName: [c.lead!.firstName, c.lead!.lastName].filter(Boolean).join(" "),
    mobile: c.lead!.mobile,
    telecaller: { id: c.agent.id, name: c.agent.name },
    products: productNames(c.lead!.abandonments[0]?.cartSnapshot),
    leadStatus: c.lead!.workingStatus,
    outcome: c.outcome?.name ?? titleCase(c.status),
    durationSeconds: c.durationSeconds ?? c.recording?.durationSeconds ?? null,
    playUrl: usable ? c.recording!.recordingUrl : null,
    unavailableReason: usable ? null : !c.recording?.recordingUrl?.trim() ? "No recording link" : c.recording?.expiresAt && c.recording.expiresAt <= now ? "Recording link expired" : "Recording not available",
  };
}

export interface CallRecordingSummary {
  totalRecordings: number;
  totalDurationSeconds: number;
  averageDurationSeconds: number;
  telecallers: number;
  todayRecordings: number;
}

export interface CallRecordingOptions {
  telecallers: { id: string; name: string }[];
  outcomes: { value: string; label: string }[];
  leadStatuses: { value: string; label: string }[];
}

export class CallRecordingsService {
  constructor(private readonly db: DbClient = prisma) {}

  private assertAllowed(user: AuthUser): void {
    if (!canAccessRecordings(user.role)) throw new ApiError("Only admins and managers can access call recordings", STATUS_CODES.FORBIDDEN);
  }

  /** The full where (filters + scope) a user's request resolves to. */
  whereFor(user: AuthUser, f: CallRecordingFilters, options?: Parameters<typeof buildCallRecordingWhere>[1]): Prisma.CallWhereInput {
    this.assertAllowed(user);
    return scopedCallRecordingWhere(user, buildCallRecordingWhere(f, options));
  }

  async list(user: AuthUser, f: CallRecordingFilters, paging: { page: number; pageSize: number }) {
    const where = this.whereFor(user, f);
    const pageSize = Math.min(Math.max(Math.floor(paging.pageSize) || 20, 1), MAX_PAGE_SIZE);
    const page = Math.max(Math.floor(paging.page) || 1, 1);
    const [rows, totalItems] = await Promise.all([
      this.db.call.findMany({ where, select: SELECT, orderBy: LIST_ORDER(f.sort), skip: (page - 1) * pageSize, take: pageSize }),
      this.db.call.count({ where }),
    ]);
    const now = new Date();
    return { items: rows.map((r) => toCallRecordingItem(r, now)), pagination: { page, pageSize, totalItems, totalPages: Math.max(Math.ceil(totalItems / pageSize), 1) } };
  }

  /** Every row of a filter, in keyset-free offset pages (used by the Excel export): oldest/newest per the filter's sort. */
  async page(user: AuthUser, f: CallRecordingFilters, skip: number, take: number) {
    const where = this.whereFor(user, f);
    const rows = await this.db.call.findMany({ where, select: SELECT, orderBy: LIST_ORDER(f.sort), skip, take });
    const now = new Date();
    return rows.map((r) => toCallRecordingItem(r, now));
  }

  async count(user: AuthUser, f: CallRecordingFilters): Promise<number> {
    return this.db.call.count({ where: this.whereFor(user, f) });
  }

  /** The cards: counted by the database for the CURRENT filters (today's card ignores the date filter and counts today, IST, under all the others). */
  async summary(user: AuthUser, f: CallRecordingFilters, now: Date = new Date()): Promise<CallRecordingSummary> {
    const where = this.whereFor(user, f);
    const today = todayString(now, REPORT_TZ_OFFSET_MINUTES);
    const todayWhere = this.whereFor(user, f, { range: { from: today, to: today } });
    const [total, ownDuration, recordingDuration, agents, todayCount] = await Promise.all([
      this.db.call.count({ where }),
      this.db.call.aggregate({ where, _sum: { durationSeconds: true } }),
      // Calls that carry no duration of their own use the recording's.
      this.db.callRecording.aggregate({ where: { call: { AND: [where, { durationSeconds: null }] } }, _sum: { durationSeconds: true } }),
      this.db.call.groupBy({ by: ["agentId"], where }),
      this.db.call.count({ where: todayWhere }),
    ]);
    const totalDurationSeconds = (ownDuration._sum.durationSeconds ?? 0) + (recordingDuration._sum.durationSeconds ?? 0);
    return { totalRecordings: total, totalDurationSeconds, averageDurationSeconds: total > 0 ? Math.round(totalDurationSeconds / total) : 0, telecallers: agents.length, todayRecordings: todayCount };
  }

  /** The choices of the filter drop-downs, from real data: telecallers who made recorded calls, the outcomes in use and the lead statuses. */
  async options(user: AuthUser): Promise<CallRecordingOptions> {
    this.assertAllowed(user);
    const scope = scopedCallRecordingWhere(user, {});
    const [agents, outcomes] = await Promise.all([this.db.call.groupBy({ by: ["agentId"], where: scope }), this.db.callOutcome.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } })]);
    const users = agents.length === 0 ? [] : await this.db.user.findMany({ where: { id: { in: agents.map((a) => a.agentId) } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    return {
      telecallers: users,
      outcomes: [
        ...outcomes.map((o) => ({ value: `outcome:${o.id}`, label: o.name })),
        ...Object.values(CallStatus).filter((s) => !HIDDEN_STATUSES.has(s)).map((s) => ({ value: `status:${s}`, label: `${titleCase(s)} (call result)` })),
      ],
      leadStatuses: Object.values(LeadWorkingStatus).filter((s) => s !== LeadWorkingStatus.DEACTIVATED).map((s) => ({ value: s, label: titleCase(s) })),
    };
  }
}
