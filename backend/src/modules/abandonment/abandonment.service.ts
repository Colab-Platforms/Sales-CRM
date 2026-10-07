import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ActivitySource, ActivityType, AbandonmentStatus, RecoveryActionStatus, Role, TaskStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { DbClient } from "@/lib/leadScope.js";
import { statusForRole } from "@/lib/leadStatusView.js";
import { FOLLOW_UP_TASK_TYPES } from "../tasks/tasks.followup.js";
import LeadService from "../lead/lead.service.js";
import { aggregateItemOptions, type ItemOption } from "./abandonment.items.js";
import { buildAbandonmentListWhere, buildAbandonmentSummary, mapAbandonmentListRow, scopedAbandonmentWhere, type AbandonmentListRow } from "./abandonment.filters.js";
import type {
  AbandonmentDetail,
  AbandonmentListResult,
  BulkAssignManagerBody,
  BulkAssignSalespersonBody,
  CreateRecoveryActionBody,
  ListAbandonmentsQuery,
  RecoveryActionItem,
  UpdateAbandonmentStatusBody,
} from "./abandonment.types.js";

const LIST_SELECT = {
  id: true,
  type: true,
  status: true,
  detectedAt: true,
  recoveredAt: true,
  priorityScore: true,
  priorityReason: true,
  referenceType: true,
  referenceId: true,
  cartSnapshot: true,
  lead: {
    select: {
      id: true,
      leadNumber: true,
      firstName: true,
      lastName: true,
      mobile: true,
      email: true,
      workingStatus: true,
      assignedManager: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true } },
      // Same shape lead.service.ts's leadListInclude.tasks/calls use, so the abandoned-leads queue and
      // lead detail page can reuse the exact same calling/history components leads already have.
      tasks: {
        where: { status: TaskStatus.PENDING, type: { in: [...FOLLOW_UP_TASK_TYPES] } },
        select: { id: true, type: true, scheduledAt: true },
        orderBy: { scheduledAt: "asc" as const },
        take: 1,
      },
      calls: {
        select: {
          id: true,
          provider: true,
          direction: true,
          status: true,
          startedAt: true,
          answeredAt: true,
          endedAt: true,
          durationSeconds: true,
          recording: { select: { recordingUrl: true } },
          agent: { select: { id: true, name: true } },
          notes: true,
          outcome: { select: { id: true, name: true, code: true } },
        },
        orderBy: { createdAt: "desc" as const },
      },
    },
  },
  source: { select: { id: true, name: true } },
  // Only the single most recent action, for the queue's "last touched" column - the full history is a
  // detail-view concern (getAbandonment below).
  recoveryActions: { select: { type: true, status: true, createdAt: true }, orderBy: { createdAt: "desc" as const }, take: 1 },
} satisfies Prisma.AbandonmentSelect;

const ITEM_OPTIONS_SCAN_LIMIT = 5000;
/** The most abandoned leads one "Select all" can pick (a bulk assign of more than this is split by narrowing the filter). */
export const MAX_SELECT_ALL = 1000;

class AbandonmentService {
  // `db` and `leadService` default to the real ones; tests pass a rolled-back transaction and a recording stub.
  constructor(
    private readonly db: DbClient = prisma,
    private readonly leadService: Pick<LeadService, "bulkAssignManagers" | "bulkAssignSalespersons"> = new LeadService(),
  ) {}

  // Same assignment-based scoping lead.service.ts's buildScopeWhere uses - a manager sees abandoned
  // leads assigned to them, a salesperson sees the ones assigned to them, so "assign to manager/
  // salesperson" on an abandoned lead moves it in and out of view exactly like a normal lead.
  private scopeWhere(user: AuthUser): Prisma.LeadWhereInput {
    if (user.role === Role.MANAGER) return { assignedManagerId: user.id };
    if (user.role === Role.SALESPERSON) return { ownerId: user.id };
    return {};
  }

  /** Every list/detail row's human summary lives on the Activity row the webhook processor wrote (same
   *  "Activity is the audit source" convention customers.timeline.ts's buildAbandonmentEntries relies on) -
   *  never duplicated onto the Abandonment row itself. */
  private async summariesFor(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.activity.findMany({
      where: { referenceType: "Abandonment", referenceId: { in: ids }, type: ActivityType.ABANDONMENT },
      orderBy: { createdAt: "desc" },
      select: { referenceId: true, description: true },
    });
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.referenceId && !map.has(row.referenceId) && row.description) map.set(row.referenceId, row.description);
    }
    return map;
  }

  async listAbandonments(user: AuthUser, query: ListAbandonmentsQuery): Promise<AbandonmentListResult> {
    const leadScope = this.scopeWhere(user);
    const where = buildAbandonmentListWhere(query, leadScope, user.role);

    const [rows, totalItems, counts] = await Promise.all([
      this.db.abandonment.findMany({
        where,
        select: LIST_SELECT,
        // Newest abandoned carts first
        orderBy: [{ detectedAt: "desc" }, { createdAt: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.abandonment.count({ where }),
      this.db.abandonment.groupBy({ by: ["status"], where, _count: { _all: true } }),
    ]);

    const summaries = await this.summariesFor(rows.map((r) => r.id));

    return {
      items: rows.map((row) => {
        const typed = row as AbandonmentListRow;
        typed.lead.workingStatus = statusForRole(typed.lead.workingStatus, user.role);
        if (user.role === Role.SALESPERSON) {
          typed.lead.calls = typed.lead.calls.map((call) => (call.recording ? { ...call, recording: { recordingUrl: null } } : call));
        }
        return mapAbandonmentListRow(typed, summaries.get(row.id) ?? null);
      }),
      summary: buildAbandonmentSummary(counts),
      pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) || 1 },
    };
  }

  /**
   * The products the Items filter offers: distinct products found in the abandoned carts the viewer may see (same lead scope as
   * the list), so a manager only gets their own queue's products. Real cart data only - nothing hardcoded. Bounded to the most
   * recent carts so the call stays cheap on a large queue.
   */
  async listItemOptions(user: AuthUser, search?: string): Promise<{ items: ItemOption[] }> {
    const leadScope = this.scopeWhere(user);
    const rows = await this.db.abandonment.findMany({
      where: Object.keys(leadScope).length > 0 ? { lead: leadScope } : {},
      select: { id: true, cartSnapshot: true },
      orderBy: { detectedAt: "desc" },
      take: ITEM_OPTIONS_SCAN_LIMIT,
    });
    return { items: aggregateItemOptions(rows, search) };
  }

  /** Ids of EVERY abandonment matching the filters (not just the current page), so "Select all N" can feed the existing bulk-assign. */
  async listMatchingIds(user: AuthUser, query: ListAbandonmentsQuery): Promise<{ ids: string[]; total: number; capped: boolean }> {
    const where = buildAbandonmentListWhere(query, this.scopeWhere(user), user.role);
    const [rows, total] = await Promise.all([
      this.db.abandonment.findMany({ where, select: { id: true }, orderBy: [{ detectedAt: "desc" }, { createdAt: "desc" }], take: MAX_SELECT_ALL }),
      this.db.abandonment.count({ where }),
    ]);
    return { ids: rows.map((r) => r.id), total, capped: total > rows.length };
  }

  private readonly DETAIL_SELECT = {
    ...LIST_SELECT,
    recoveryActions: {
      select: { id: true, type: true, status: true, notes: true, createdAt: true, completedAt: true, performedBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" as const },
    },
  } satisfies Prisma.AbandonmentSelect;

  private async detailFromRow(
    user: AuthUser,
    row:
      | (Omit<AbandonmentListRow, "recoveryActions"> & {
          referenceType: string | null;
          referenceId: string | null;
          recoveryActions: { id: string; type: RecoveryActionItem["type"]; status: RecoveryActionItem["status"]; notes: string | null; createdAt: Date; completedAt: Date | null; performedBy: { id: string; name: string } | null }[];
        })
      | null,
  ): Promise<AbandonmentDetail | null> {
    if (!row) return null;
    const summary = (await this.summariesFor([row.id])).get(row.id) ?? null;
    const recoveryActions: RecoveryActionItem[] = row.recoveryActions.map((a) => ({
      id: a.id,
      type: a.type,
      status: a.status,
      notes: a.notes,
      createdAt: a.createdAt,
      completedAt: a.completedAt,
      performedBy: a.performedBy,
    }));

    row.lead.workingStatus = statusForRole(row.lead.workingStatus, user.role);
    if (user.role === Role.SALESPERSON) {
      row.lead.calls = row.lead.calls.map((call) => (call.recording ? { ...call, recording: { recordingUrl: null } } : call));
    }

    return {
      ...mapAbandonmentListRow(row, summary),
      reference: { referenceType: row.referenceType, referenceId: row.referenceId },
      recoveryActions,
    };
  }

  async getAbandonment(user: AuthUser, id: string): Promise<AbandonmentDetail> {
    const leadScope = this.scopeWhere(user);
    const row = await this.db.abandonment.findFirst({
      where: scopedAbandonmentWhere(id, leadScope),
      select: this.DETAIL_SELECT,
    });
    if (!row) throw new ApiError("Abandonment not found", STATUS_CODES.NOT_FOUND);
    return (await this.detailFromRow(user, row))!;
  }

  // The lead-detail page (same page normal leads open) embeds this abandoned-checkout panel directly,
  // rather than sending the salesperson/manager to a separate queue - so it looks up by leadId, not
  // abandonmentId, and returns null (not 404) when this lead never had one.
  async getAbandonmentByLead(user: AuthUser, leadId: string): Promise<AbandonmentDetail | null> {
    const leadScope = this.scopeWhere(user);
    const row = await this.db.abandonment.findFirst({
      where: { leadId, lead: Object.keys(leadScope).length > 0 ? leadScope : undefined },
      select: this.DETAIL_SELECT,
      orderBy: [{ detectedAt: "desc" }, { createdAt: "desc" }],
    });
    return this.detailFromRow(user, row);
  }

  async createRecoveryAction(user: AuthUser, abandonmentId: string, body: CreateRecoveryActionBody) {
    const leadScope = this.scopeWhere(user);
    const abandonment = await this.db.abandonment.findFirst({ where: scopedAbandonmentWhere(abandonmentId, leadScope), select: { id: true, leadId: true, status: true } });
    if (!abandonment) throw new ApiError("Abandonment not found", STATUS_CODES.NOT_FOUND);
    if (abandonment.status === AbandonmentStatus.RECOVERED) throw new ApiError("This abandonment is already marked recovered", STATUS_CODES.CONFLICT);

    const status = body.status ?? RecoveryActionStatus.PENDING;
    const now = new Date();

    return this.db.$transaction(async (tx) => {
      const action = await tx.recoveryAction.create({
        data: {
          abandonmentId: abandonment.id,
          leadId: abandonment.leadId,
          type: body.type,
          status,
          performedById: user.id,
          notes: body.notes,
          completedAt: status === RecoveryActionStatus.SUCCESS || status === RecoveryActionStatus.FAILED ? now : null,
        },
      });

      // A recovery attempt in flight or completed moves the abandonment out of the untouched ACTIVE
      // state; a successful one closes it out entirely. A FAILED single attempt does not - the
      // telecaller keeps working it (or later marks it NOT_RECOVERED explicitly via updateStatus).
      const nextStatus = status === RecoveryActionStatus.SUCCESS ? AbandonmentStatus.RECOVERED : AbandonmentStatus.IN_PROGRESS;
      await tx.abandonment.update({
        where: { id: abandonment.id },
        data: { status: nextStatus, recoveredAt: nextStatus === AbandonmentStatus.RECOVERED ? now : undefined },
      });

      await tx.activity.create({
        data: {
          leadId: abandonment.leadId,
          type: ActivityType.RECOVERY,
          referenceType: "RecoveryAction",
          referenceId: action.id,
          actorId: user.id,
          actorRole: user.role,
          source: ActivitySource.USER,
          title: `Recovery ${body.type.toLowerCase().replace("_", " ")} logged`,
          description: body.notes ?? null,
        },
      });

      return action;
    });
  }

  async updateStatus(user: AuthUser, abandonmentId: string, body: UpdateAbandonmentStatusBody) {
    const leadScope = this.scopeWhere(user);
    const abandonment = await this.db.abandonment.findFirst({ where: scopedAbandonmentWhere(abandonmentId, leadScope), select: { id: true, leadId: true } });
    if (!abandonment) throw new ApiError("Abandonment not found", STATUS_CODES.NOT_FOUND);

    const now = new Date();
    const updated = await this.db.$transaction(async (tx) => {
      const result = await tx.abandonment.update({
        where: { id: abandonment.id },
        data: { status: body.status, recoveredAt: body.status === AbandonmentStatus.RECOVERED ? now : undefined },
      });
      await tx.activity.create({
        data: {
          leadId: abandonment.leadId,
          type: ActivityType.STATUS_CHANGE,
          referenceType: "Abandonment",
          referenceId: abandonment.id,
          actorId: user.id,
          actorRole: user.role,
          source: ActivitySource.USER,
          title: `Abandonment marked ${body.status.toLowerCase().replace("_", " ")}`,
        },
      });
      return result;
    });
    return updated;
  }

  // ---------- Assignment (delegates the actual write to LeadService - an abandoned lead's
  // assignedManagerId/ownerId IS the underlying Lead's, so assigning it is exactly assigning
  // that Lead) ----------

  async bulkAssignManager(user: AuthUser, body: BulkAssignManagerBody) {
    const abandonments = await this.db.abandonment.findMany({
      where: { id: { in: body.abandonmentIds } },
      select: { id: true, leadId: true },
    });
    if (abandonments.length !== body.abandonmentIds.length) {
      throw new ApiError("One or more abandoned leads not found", STATUS_CODES.NOT_FOUND);
    }
    const leadIds = [...new Set(abandonments.map((a) => a.leadId))];
    return this.leadService.bulkAssignManagers(user.id, {
      leadIds,
      method: body.method,
      managerId: body.managerId,
      managerIds: body.managerIds,
    });
  }

  async bulkAssignSalesperson(user: AuthUser, body: BulkAssignSalespersonBody) {
    const scope = this.scopeWhere(user);
    const abandonments = await this.db.abandonment.findMany({
      where: { id: { in: body.abandonmentIds }, lead: scope },
      select: { id: true, leadId: true },
    });
    if (abandonments.length !== body.abandonmentIds.length) {
      throw new ApiError("One or more abandoned leads not found", STATUS_CODES.NOT_FOUND);
    }
    const leadIds = [...new Set(abandonments.map((a) => a.leadId))];
    return this.leadService.bulkAssignSalespersons(user.id, {
      leadIds,
      method: body.method,
      salespersonId: body.salespersonId,
      salespersonIds: body.salespersonIds,
    });
  }
}

export default AbandonmentService;
