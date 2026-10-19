import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { Role } from "../../../generated/prisma/enums.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { buildCallSummary, buildCallWhere, scopedCallWhere } from "./call.history.filters.js";
import { extractSafeProviderMetadata } from "./call.history.metadata.js";
import type { CallDetail, CallLeadRef, CallListItem, CallListResult, CallSummary, CallSummaryQuery, ListCallsQuery } from "./call.history.types.js";

/**
 * `GET /api/calls` / `GET /api/calls/:id` / `GET /api/calls/summary` — read-only, reads directly from
 * `Call` and its relations (`agent`/`lead`/`outcome`/`recording`/`virtualNumber`). Also backs the IVR
 * reporting pages (CRM -> IVR -> Inbound/Outbound): those are the exact same `Call` rows, filtered by
 * `direction`, not a separate data source - see call.history.metadata.ts for why no schema change was
 * needed to add campid/error_code/etc. to the detail view. Deliberately does NOT touch
 * `activity.findMany()` (the query that's currently broken by an unrelated, already-diagnosed
 * migration-ordering gap — see the audit/customers modules) - the Call table itself, and everything
 * selected here, is unaffected by that gap.
 *
 * Authorisation starts from OrdersService's exact pattern: `getLeadScope` gives the same
 * ADMIN-sees-all / MANAGER-sees-their-team / SALESPERSON-sees-their-own scoping already used by
 * orders/customers/audit, applied here through the Call -> Lead relation. On top of that, every
 * call here also passes `user.id` as `buildCallWhere`/`scopedCallWhere`'s `viewerId` - which OR's
 * in "or I am this call's agent", so a call on an unassigned Lead (e.g. a new "IVR Inquiry" Lead)
 * is still visible to the salesperson who actually took it. The IVR pages use this same scoping -
 * there is no second authorisation system for them.
 */

const LIST_SELECT = {
  id: true,
  direction: true,
  status: true,
  startedAt: true,
  endedAt: true,
  durationSeconds: true,
  createdAt: true,
  agent: { select: { id: true, name: true } },
  lead: { select: { id: true, leadNumber: true, firstName: true, lastName: true, mobile: true } },
  outcome: { select: { name: true, category: true } },
  recording: { select: { id: true } },
  agentNumber: true,
  customerNumber: true,
  providerCallId: true,
  virtualNumber: { select: { id: true, number: true, displayName: true } },
  provider: true,
  callGroup: true,
} satisfies Prisma.CallSelect;

const DETAIL_SELECT = {
  ...LIST_SELECT,
  answeredAt: true,
  notes: true,
  // Overrides LIST_SELECT's `recording: { select: { id: true } }` - the detail view is the only
  // place the raw URL is ever selected, and even then it's redacted by role below before leaving
  // the service (see mapCallDetail's `canSeeRecording`).
  recording: { select: { id: true, recordingUrl: true } },
} satisfies Prisma.CallSelect;

type ListRow = Prisma.CallGetPayload<{ select: typeof LIST_SELECT }>;
type DetailRow = Prisma.CallGetPayload<{ select: typeof DETAIL_SELECT }>;

// Fallback selects for an environment where the `20261016000000_add_call_group` migration hasn't
// been applied yet (`Call.callGroup` exists in the Prisma schema/client but not in the live
// database) - see isMissingCallGroupColumnError below. Every OTHER field still works; only the
// call-group reporting itself degrades (callGroup: null everywhere, no tabs), instead of the whole
// IVR Inbound page/Call History 500ing on a column the code merely hasn't been deployed a migration
// for yet.
const { callGroup: _listCallGroup, ...LIST_SELECT_WITHOUT_CALL_GROUP } = LIST_SELECT;
const { callGroup: _detailCallGroup, ...DETAIL_SELECT_WITHOUT_CALL_GROUP } = DETAIL_SELECT;

/** True only for the exact, identifiable "calls.call_group column does not exist" failure - never a
 * blanket P2022 catch-all, so an unrelated missing-column bug still surfaces as a real error rather
 * than being silently swallowed here. */
export function isMissingCallGroupColumnError(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2022") return false;
  const cause = (err.meta as { driverAdapterError?: { cause?: { kind?: string; originalMessage?: string } } } | undefined)
    ?.driverAdapterError?.cause;
  return cause?.kind === "ColumnNotFound" && typeof cause.originalMessage === "string" && cause.originalMessage.includes("call_group");
}

export function mapCallListItem(row: ListRow): CallListItem {
  return {
    id: row.id,
    lead: row.lead as CallLeadRef, // never null: every query above excludes lead-less (recruiter) calls
    agent: row.agent,
    direction: row.direction,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationSeconds: row.durationSeconds,
    outcome: row.outcome,
    hasRecording: row.recording !== null,
    createdAt: row.createdAt,
    agentNumber: row.agentNumber,
    customerNumber: row.customerNumber,
    virtualNumber: row.virtualNumber ? { displayName: row.virtualNumber.displayName, number: row.virtualNumber.number } : null,
    providerCallId: row.providerCallId,
    callGroup: row.callGroup,
  };
}

// Only ADMIN/MANAGER ever receive a playable recording URL - same rule the legacy /api/calling
// module already applies (calling.service.ts#listCallsForLead), reused here rather than invented.
function canSeeRecordingUrl(role: Role): boolean {
  return role === Role.ADMIN || role === Role.MANAGER;
}

export function mapCallDetail(row: DetailRow, role: Role, providerMetadata: ReturnType<typeof extractSafeProviderMetadata>): CallDetail {
  return {
    ...mapCallListItem(row),
    answeredAt: row.answeredAt,
    notes: row.notes,
    // Never the provider recording URL itself in `callingIdentity` - only whether a business number was involved.
    callingIdentity: row.virtualNumber ? { displayName: row.virtualNumber.displayName, number: row.virtualNumber.number } : null,
    recordingUrl: canSeeRecordingUrl(role) ? (row.recording?.recordingUrl ?? null) : null,
    providerMetadata,
  };
}

// Recruiter calls hang off an Application and have no lead; this sales call history (and the IVR pages built on it) is about
// calls on leads, so those rows are never part of it.
const CALLS_ON_LEADS: Prisma.CallWhereInput = { leadId: { not: null } };

function groupCallsByCallGroup(db: DbClient, where: Prisma.CallWhereInput) {
  return db.call.groupBy({ by: ["callGroup"], where, _count: { _all: true } });
}

export class CallHistoryService {
  constructor(private readonly db: DbClient = prisma) {}

  async listCalls(user: AuthUser, query: ListCallsQuery): Promise<CallListResult> {
    const leadScope = await getLeadScope(user, this.db);
    const where: Prisma.CallWhereInput = { AND: [buildCallWhere(query, leadScope, user.id), CALLS_ON_LEADS] };
    const page = {
      // id breaks ties so pages never repeat or skip rows created in the same instant.
      orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    };

    // Single findMany with nested selects (one query with joins), not N+1: the same pattern
    // orders.service.ts#listOrders uses for its own lead/payments relations.
    let total: number;
    let rows: ListRow[];
    try {
      [total, rows] = await Promise.all([this.db.call.count({ where }), this.db.call.findMany({ where, select: LIST_SELECT, ...page })]);
    } catch (err) {
      if (!isMissingCallGroupColumnError(err)) throw err;
      const [fallbackTotal, fallbackRows] = await Promise.all([
        this.db.call.count({ where }),
        this.db.call.findMany({ where, select: LIST_SELECT_WITHOUT_CALL_GROUP, ...page }),
      ]);
      total = fallbackTotal;
      rows = fallbackRows.map((row) => ({ ...row, callGroup: null }));
    }

    return {
      data: rows.map(mapCallListItem),
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  /** Aggregate counts/talk-time for the IVR summary cards - same filters/scope as `listCalls`, no rows returned. */
  async getCallSummary(user: AuthUser, query: CallSummaryQuery): Promise<CallSummary> {
    const leadScope = await getLeadScope(user, this.db);
    const where: Prisma.CallWhereInput = { AND: [buildCallWhere(query, leadScope, user.id), CALLS_ON_LEADS] };

    const [counts, totalTalkTime] = await Promise.all([
      this.db.call.groupBy({ by: ["status"], where, _count: { _all: true } }),
      this.db.call.aggregate({ where, _sum: { durationSeconds: true } }),
    ]);

    // Isolated from the Promise.all above on purpose: a missing call_group column must only drop
    // the call-group breakdown (empty tabs), never the status counts/talk-time the summary cards
    // already show today.
    let callGroupCounts: Awaited<ReturnType<typeof groupCallsByCallGroup>> = [];
    try {
      callGroupCounts = await groupCallsByCallGroup(this.db, where);
    } catch (err) {
      if (!isMissingCallGroupColumnError(err)) throw err;
    }

    return buildCallSummary(counts, totalTalkTime._sum.durationSeconds, callGroupCounts);
  }

  async getCallById(user: AuthUser, id: string): Promise<CallDetail> {
    const leadScope = await getLeadScope(user, this.db);
    const whereScoped: Prisma.CallWhereInput = { AND: [scopedCallWhere(id, leadScope, user.id), CALLS_ON_LEADS] };

    let call: DetailRow | null;
    try {
      call = await this.db.call.findFirst({ where: whereScoped, select: DETAIL_SELECT });
    } catch (err) {
      if (!isMissingCallGroupColumnError(err)) throw err;
      const row = await this.db.call.findFirst({ where: whereScoped, select: DETAIL_SELECT_WITHOUT_CALL_GROUP });
      call = row ? { ...row, callGroup: null } : null;
    }

    // Out-of-scope calls look the same as missing ones so ids can't be probed (matches getOrder).
    if (!call) {
      throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);
    }

    const providerMetadata = call.providerCallId ? await this.getProviderMetadata(call.provider, call.providerCallId) : null;

    return mapCallDetail(call, user.role, providerMetadata);
  }

  /** Reads back the safe subset of the already-stored Call Report webhook payload for this call -
   * no new table, no new Call column (see call.history.metadata.ts's header comment for why). */
  private async getProviderMetadata(provider: string, providerCallId: string) {
    const event = await this.db.webhookEvent.findFirst({
      where: { provider, eventType: "call_report", externalEventId: providerCallId },
      select: { payload: true },
      orderBy: { receivedAt: "desc" },
    });
    return event ? extractSafeProviderMetadata(event.payload) : null;
  }
}
