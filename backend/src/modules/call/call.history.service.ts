import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { buildCallWhere, scopedCallWhere } from "./call.history.filters.js";
import type { CallDetail, CallListItem, CallListResult, ListCallsQuery } from "./call.history.types.js";

/**
 * `GET /api/calls` / `GET /api/calls/:id` — read-only, reads directly from `Call` and its relations
 * (`agent`/`lead`/`outcome`/`recording`/`virtualNumber`). Deliberately does NOT touch
 * `activity.findMany()` (the query that's currently broken by an unrelated, already-diagnosed
 * migration-ordering gap — see the audit/customers modules) - the Call table itself, and everything
 * selected here, is unaffected by that gap.
 *
 * Authorisation mirrors OrdersService exactly: `getLeadScope` gives the same
 * ADMIN-sees-all / MANAGER-sees-their-team / SALESPERSON-sees-their-own scoping already used by
 * orders/customers/audit, applied here through the Call -> Lead relation (Call itself has no owner
 * field, so it is never used as the authorisation boundary on its own).
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
} satisfies Prisma.CallSelect;

const DETAIL_SELECT = {
  ...LIST_SELECT,
  answeredAt: true,
  notes: true,
  virtualNumber: { select: { number: true, displayName: true } },
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
  };
}

export function mapCallDetail(row: DetailRow): CallDetail {
  return {
    ...mapCallListItem(row),
    answeredAt: row.answeredAt,
    notes: row.notes,
    // Never the provider recording URL itself - only whether a business number was involved.
    callingIdentity: row.virtualNumber ? { displayName: row.virtualNumber.displayName, number: row.virtualNumber.number } : null,
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

  async getCallById(user: AuthUser, id: string): Promise<CallDetail> {
    const leadScope = await getLeadScope(user, this.db);
    const call = await this.db.call.findFirst({ where: scopedCallWhere(id, leadScope), select: DETAIL_SELECT });

    // Out-of-scope calls look the same as missing ones so ids can't be probed (matches getOrder).
    if (!call) {
      throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);
    }

    return mapCallDetail(call);
  }
}
