import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { Role } from "../../../generated/prisma/enums.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { buildCallSummary, buildCallWhere, scopedCallWhere } from "./call.history.filters.js";
import { extractSafeProviderMetadata } from "./call.history.metadata.js";
import type { CallDetail, CallListItem, CallListResult, CallSummary, CallSummaryQuery, ListCallsQuery } from "./call.history.types.js";

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
 * Authorisation mirrors OrdersService exactly: `getLeadScope` gives the same
 * ADMIN-sees-all / MANAGER-sees-their-team / SALESPERSON-sees-their-own scoping already used by
 * orders/customers/audit, applied here through the Call -> Lead relation (Call itself has no owner
 * field, so it is never used as the authorisation boundary on its own). The IVR pages use this same
 * scoping - there is no second authorisation system for them.
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

export function mapCallListItem(row: ListRow): CallListItem {
  return {
    id: row.id,
    lead: row.lead,
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

export class CallHistoryService {
  constructor(private readonly db: DbClient = prisma) {}

  async listCalls(user: AuthUser, query: ListCallsQuery): Promise<CallListResult> {
    const leadScope = await getLeadScope(user, this.db);
    const where = buildCallWhere(query, leadScope);

    // Single findMany with nested selects (one query with joins), not N+1: the same pattern
    // orders.service.ts#listOrders uses for its own lead/payments relations.
    const [total, rows] = await Promise.all([
      this.db.call.count({ where }),
      this.db.call.findMany({
        where,
        select: LIST_SELECT,
        // id breaks ties so pages never repeat or skip rows created in the same instant.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      data: rows.map(mapCallListItem),
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  /** Aggregate counts/talk-time for the IVR summary cards - same filters/scope as `listCalls`, no rows returned. */
  async getCallSummary(user: AuthUser, query: CallSummaryQuery): Promise<CallSummary> {
    const leadScope = await getLeadScope(user, this.db);
    const where = buildCallWhere(query, leadScope);

    const [counts, totalTalkTime] = await Promise.all([
      this.db.call.groupBy({ by: ["status"], where, _count: { _all: true } }),
      this.db.call.aggregate({ where, _sum: { durationSeconds: true } }),
    ]);

    return buildCallSummary(counts, totalTalkTime._sum.durationSeconds);
  }

  async getCallById(user: AuthUser, id: string): Promise<CallDetail> {
    const leadScope = await getLeadScope(user, this.db);
    const call = await this.db.call.findFirst({ where: scopedCallWhere(id, leadScope), select: DETAIL_SELECT });

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
