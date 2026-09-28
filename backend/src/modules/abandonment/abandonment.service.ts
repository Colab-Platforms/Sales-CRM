import { prisma } from "@/lib/prisma.js";
import { getLeadScope } from "@/lib/leadScope.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ActivitySource, ActivityType, AbandonmentStatus, RecoveryActionStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { buildAbandonmentListWhere, buildAbandonmentSummary, mapAbandonmentListRow, scopedAbandonmentWhere, type AbandonmentListRow } from "./abandonment.filters.js";
import type {
  AbandonmentDetail,
  AbandonmentListResult,
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
  lead: { select: { id: true, leadNumber: true, firstName: true, lastName: true, mobile: true, email: true } },
  source: { select: { id: true, name: true } },
  // Only the single most recent action, for the queue's "last touched" column - the full history is a
  // detail-view concern (getAbandonment below).
  recoveryActions: { select: { type: true, status: true, createdAt: true }, orderBy: { createdAt: "desc" as const }, take: 1 },
} satisfies Prisma.AbandonmentSelect;

class AbandonmentService {
  private readonly db = prisma;

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
    const leadScope = await getLeadScope(user, this.db);
    const where = buildAbandonmentListWhere(query, leadScope);

    const [rows, totalItems, counts] = await Promise.all([
      this.db.abandonment.findMany({
        where,
        select: LIST_SELECT,
        // Highest-value, most-recently-abandoned carts first; a cart with no known value sorts after
        // every priced one but is still shown, newest first.
        orderBy: [{ priorityScore: { sort: "desc", nulls: "last" } }, { detectedAt: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.abandonment.count({ where }),
      this.db.abandonment.groupBy({ by: ["status"], where, _count: { _all: true } }),
    ]);

    const summaries = await this.summariesFor(rows.map((r) => r.id));

    return {
      items: rows.map((row) => mapAbandonmentListRow(row as AbandonmentListRow, summaries.get(row.id) ?? null)),
      summary: buildAbandonmentSummary(counts),
      pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) || 1 },
    };
  }

  async getAbandonment(user: AuthUser, id: string): Promise<AbandonmentDetail> {
    const leadScope = await getLeadScope(user, this.db);
    const row = await this.db.abandonment.findFirst({
      where: scopedAbandonmentWhere(id, leadScope),
      select: {
        ...LIST_SELECT,
        recoveryActions: {
          select: { id: true, type: true, status: true, notes: true, createdAt: true, completedAt: true, performedBy: { select: { id: true, name: true } } },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!row) throw new ApiError("Abandonment not found", STATUS_CODES.NOT_FOUND);

    const summary = (await this.summariesFor([id])).get(id) ?? null;
    const recoveryActions: RecoveryActionItem[] = row.recoveryActions.map((a) => ({
      id: a.id,
      type: a.type,
      status: a.status,
      notes: a.notes,
      createdAt: a.createdAt,
      completedAt: a.completedAt,
      performedBy: a.performedBy,
    }));

    return {
      ...mapAbandonmentListRow(row as AbandonmentListRow, summary),
      reference: { referenceType: row.referenceType, referenceId: row.referenceId },
      recoveryActions,
    };
  }

  async createRecoveryAction(user: AuthUser, abandonmentId: string, body: CreateRecoveryActionBody) {
    const leadScope = await getLeadScope(user, this.db);
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
    const leadScope = await getLeadScope(user, this.db);
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
}

export default AbandonmentService;
