import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ActivitySource, ActivityType, AbandonmentStatus, CallDirection, RecoveryActionStatus, Role, TaskStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { DbClient } from "@/lib/leadScope.js";
import { statusForRole } from "@/lib/leadStatusView.js";
import { FOLLOW_UP_TASK_TYPES } from "../tasks/tasks.followup.js";
import LeadService from "../lead/lead.service.js";
import { aggregateItemOptions, type ItemOption } from "./abandonment.items.js";
import { buildOrderPrefill, type OrderPrefill } from "./abandonment.order-prefill.js";
import { getDistribution, getTelecallerSummary, listTelecallers, type Distribution, type TelecallerSummary } from "./abandonment.distribution.js";
import { getIngestionStatus, FASTRR_PROVIDER, type IngestionStatus } from "./abandonment.ingestion-status.js";
import { reconcileFailedAbandonmentEvents, type ReconcileResult } from "../shiprocket/shiprocket.abandonment.reconcile.js";
import { abandonmentStore } from "../shiprocket/shiprocket.abandonment.store.js";
import { abandonmentDerivedWhere, buildAbandonmentListWhere, buildAbandonmentSummary, mapAbandonmentListRow, classifyCallStatus, scopedAbandonmentWhere, type AbandonmentListRow, abandonmentLeadScope } from "./abandonment.filters.js";
import { loadCustomerContext } from "./abandonment.customer-context.js";
import { defaultLiveHistoryClient, type LiveHistoryClientFactory } from "./abandonment.shopify-history.js";
import type {
  CallAttemptBreakdown,
  AbandonmentDetail,
  AbandonmentListResult,
  BulkAssignManagerBody,
  BulkAssignSalespersonBody,
  BulkUpdateLeadStatusBody,
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
      // Call attempts: how many outbound calls were placed to this lead (the Call table, one row per placed call). One aggregate per page of rows - never a query per lead.
      _count: { select: { calls: { where: { direction: CallDirection.OUTBOUND } } } },
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
    private readonly leadService: Pick<LeadService, "bulkAssignManagers" | "bulkAssignSalespersons" | "bulkAssignSalespersonsByStaff" | "bulkUpdateStatus"> = new LeadService(),
    // The store's own order history (read-only). Injectable so tests use a fake and never reach Shopify; pass null to skip it.
    private readonly liveHistory: LiveHistoryClientFactory | null = defaultLiveHistoryClient,
  ) {}

  // Same assignment-based scoping lead.service.ts's buildScopeWhere uses - a manager sees abandoned
  // leads assigned to them, a salesperson sees the ones assigned to them, so "assign to manager/
  // salesperson" on an abandoned lead moves it in and out of view exactly like a normal lead.
  // ADMIN and HR see every abandoned lead (HR deliberately, for lead distribution only: the global lead scope in lib/leadScope.ts still gives HR no
  // access to leads, orders or customers - HR gets this module's list and distribution, nothing else). A role this module does not know sees nothing.
  private scopeWhere(user: AuthUser): Prisma.LeadWhereInput {
    return abandonmentLeadScope(user);
  }

  // HR may LIST abandoned leads and distribute them, but never open or work one (detail, cart/address prefill, recovery actions, status changes).
  private assertWorkRole(user: AuthUser): void {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER && user.role !== Role.SALESPERSON) throw new ApiError("You do not have permission to work abandoned leads", STATUS_CODES.FORBIDDEN);
  }

  // A telecaller can only ever ask about their own leads: naming another telecaller is refused outright (not merely answered with an empty list).
  private assertOwnTelecallerFilter(user: AuthUser, query: ListAbandonmentsQuery): void {
    if (user.role === Role.SALESPERSON && query.salespersonId && query.salespersonId !== user.id) {
      throw new ApiError("You can only view your own leads", STATUS_CODES.FORBIDDEN);
    }
    if (user.role === Role.SALESPERSON && query.managerId) {
      throw new ApiError("You can only view your own leads", STATUS_CODES.FORBIDDEN);
    }
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

  /** The list where plus the value / last-action column filters, so the list, its total, its summary and "Select all" always agree. */
  private async listWhere(query: ListAbandonmentsQuery, leadScope: Prisma.LeadWhereInput, role: Role): Promise<Prisma.AbandonmentWhereInput> {
    const where = buildAbandonmentListWhere(query, leadScope, role);
    const derived = await abandonmentDerivedWhere(this.db, query);
    return derived ? { AND: [where, derived] } : where;
  }

  async listAbandonments(user: AuthUser, query: ListAbandonmentsQuery): Promise<AbandonmentListResult> {
    this.assertOwnTelecallerFilter(user, query);
    const leadScope = this.scopeWhere(user);
    const where = await this.listWhere(query, leadScope, user.role);

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
    const breakdowns = await this.callBreakdowns(rows.map((r) => r.lead.id));

    return {
      items: rows.map((row) => {
        const typed = row as AbandonmentListRow;
        typed.lead.workingStatus = statusForRole(typed.lead.workingStatus, user.role);
        if (user.role === Role.SALESPERSON) {
          typed.lead.calls = typed.lead.calls.map((call) => (call.recording ? { ...call, recording: { recordingUrl: null } } : call));
        }
        const item = mapAbandonmentListRow(typed, summaries.get(row.id) ?? null);
        item.lead.callBreakdown = breakdowns.get(row.lead.id) ?? { successful: 0, failed: 0, ringing: 0 };
        return item;
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
  /** Outbound call attempts per lead split into successful / failed / ringing: ONE grouped query for the whole page of leads (never one per lead). Inbound calls are not attempts. */
  private async callBreakdowns(leadIds: string[]): Promise<Map<string, CallAttemptBreakdown>> {
    const out = new Map<string, CallAttemptBreakdown>();
    if (leadIds.length === 0) return out;
    const groups = await this.db.call.groupBy({ by: ["leadId", "status"], where: { leadId: { in: leadIds }, direction: CallDirection.OUTBOUND }, _count: { _all: true } });
    for (const g of groups) {
      if (!g.leadId) continue;
      const b = out.get(g.leadId) ?? { successful: 0, failed: 0, ringing: 0 };
      b[classifyCallStatus(g.status)] += g._count._all;
      out.set(g.leadId, b);
    }
    return out;
  }

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
    this.assertOwnTelecallerFilter(user, query);
    const where = await this.listWhere(query, this.scopeWhere(user), user.role);
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
    if (user.role === Role.SALESPERSON || user.role === Role.HR) {
      row.lead.calls = row.lead.calls.map((call) => (call.recording ? { ...call, recording: { recordingUrl: null } } : call));
    }

    // The customer behind this abandoned lead: the full delivery address and their earlier orders (see abandonment.customer-context.ts).
    const customer = await loadCustomerContext(this.db, row.lead.id, row.cartSnapshot, this.liveHistory);

    return {
      ...mapAbandonmentListRow(row, summary),
      reference: { referenceType: row.referenceType, referenceId: row.referenceId },
      recoveryActions,
      ...customer,
    };
  }

  async getAbandonment(user: AuthUser, id: string): Promise<AbandonmentDetail> {
    this.assertWorkRole(user);
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
    this.assertWorkRole(user);
    const leadScope = this.scopeWhere(user);
    const row = await this.db.abandonment.findFirst({
      where: { leadId, lead: Object.keys(leadScope).length > 0 ? leadScope : undefined },
      select: this.DETAIL_SELECT,
      orderBy: [{ detectedAt: "desc" }, { createdAt: "desc" }],
    });
    return this.detailFromRow(user, row);
  }

  /** The saved cart + address of ONE abandoned checkout, shaped for the Create Order form. Same visibility rule as the abandonment itself. */
  async getOrderPrefill(user: AuthUser, id: string): Promise<OrderPrefill> {
    this.assertWorkRole(user);
    const leadScope = this.scopeWhere(user);
    const row = await this.db.abandonment.findFirst({
      where: scopedAbandonmentWhere(id, leadScope),
      select: { id: true, leadId: true, referenceId: true, cartSnapshot: true, lead: { select: { firstName: true, lastName: true, mobile: true, email: true, normalizedMobile: true, normalizedEmail: true } } },
    });
    if (!row) throw new ApiError("Abandonment not found", STATUS_CODES.NOT_FOUND);
    return buildOrderPrefill(this.db as never, row);
  }

  async createRecoveryAction(user: AuthUser, abandonmentId: string, body: CreateRecoveryActionBody) {
    this.assertWorkRole(user);
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
    this.assertWorkRole(user);
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

  /** Health of the Fastrr ingestion (admin / manager / HR): counts and times only. */
  getIngestionStatus(user: AuthUser, period: "today" | "yesterday" | "all"): Promise<IngestionStatus> {
    return getIngestionStatus(this.db, user, period);
  }

  /** Re-drive stored deliveries that failed for good (admin only; bounded; never auto-assigns). */
  async reconcileIngestion(user: AuthUser, options: { sinceHours?: number; limit?: number }): Promise<ReconcileResult> {
    if (user.role !== Role.ADMIN) throw new ApiError("Only an admin can re-process failed deliveries", STATUS_CODES.FORBIDDEN);
    return reconcileFailedAbandonmentEvents({ db: this.db, runner: this.db as never, store: abandonmentStore, provider: FASTRR_PROVIDER }, options);
  }

  /** Distribution dashboard (admin / manager / HR): counts by telecaller for a period, inside the viewer's own scope. */
  getDistribution(user: AuthUser, range: "today" | "yesterday" | "all"): Promise<Distribution> {
    return getDistribution(this.db, user, range);
  }

  /** A telecaller's own workload (derived from the authenticated user only). */
  getMySummary(user: AuthUser): Promise<TelecallerSummary> {
    return getTelecallerSummary(this.db, user);
  }

  /** Who can be assigned: every active telecaller for admin / HR, the team for a manager. Never available to a telecaller. */
  async listAssignableTelecallers(user: AuthUser): Promise<{ id: string; name: string }[]> {
    if (user.role !== Role.ADMIN && user.role !== Role.HR && user.role !== Role.MANAGER) throw new ApiError("You cannot assign leads", STATUS_CODES.FORBIDDEN);
    return listTelecallers(this.db, user);
  }

  async bulkAssignSalesperson(user: AuthUser, body: BulkAssignSalespersonBody) {
    // Enforced here as well as on the route: only admin, manager and HR assign. A telecaller (or any other role) is refused whatever route is used.
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER && user.role !== Role.HR) throw new ApiError("You do not have permission to assign leads", STATUS_CODES.FORBIDDEN);
    if (user.role === Role.ADMIN || user.role === Role.HR) {
      if (body.method !== "MANUAL" || !body.salespersonId) throw new ApiError("Choose one telecaller to assign these leads to", STATUS_CODES.BAD_REQUEST);
      const found = await this.db.abandonment.findMany({ where: { id: { in: body.abandonmentIds } }, select: { leadId: true } });
      if (found.length !== new Set(body.abandonmentIds).size) throw new ApiError("One or more abandoned leads not found", STATUS_CODES.NOT_FOUND);
      return this.leadService.bulkAssignSalespersonsByStaff(user.id, { leadIds: [...new Set(found.map((a) => a.leadId))], salespersonId: body.salespersonId }, this.db as never);
    }
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

  // Admin-only, no scope filter - same as bulkAssignManager above - since this route is ADMIN-only.
  async bulkUpdateLeadStatus(user: AuthUser, body: BulkUpdateLeadStatusBody) {
    const abandonments = await this.db.abandonment.findMany({
      where: { id: { in: body.abandonmentIds } },
      select: { id: true, leadId: true },
    });
    if (abandonments.length !== body.abandonmentIds.length) {
      throw new ApiError("One or more abandoned leads not found", STATUS_CODES.NOT_FOUND);
    }
    const leadIds = [...new Set(abandonments.map((a) => a.leadId))];
    return this.leadService.bulkUpdateStatus(user, { leadIds, workingStatus: body.workingStatus, followUpAt: body.followUpAt });
  }
}

export default AbandonmentService;
