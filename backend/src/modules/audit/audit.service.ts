import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { scopedLeadWhere } from "../customers/customers.filters.js";
import { scopedOrderWhere } from "../orders/orders.filters.js";
import { ORDER_REFERENCE_TYPE } from "../orders/orders.types.js";
import { buildAuditWhere, mapAuditEntry, orderAuditWhere } from "./audit.filters.js";
import type { AuditListResult, EntityAuditQuery, ListAuditQuery } from "./audit.types.js";

const AUDIT_SELECT = {
  id: true,
  createdAt: true,
  type: true,
  referenceType: true,
  referenceId: true,
  leadId: true,
  title: true,
  description: true,
  oldValue: true,
  newValue: true,
  metadata: true,
  source: true,
  actorRole: true,
  actor: { select: { id: true, name: true } },
  lead: { select: { id: true, leadNumber: true, firstName: true, lastName: true } },
  order: { select: { id: true, orderNumber: true, externalNumber: true } },
} satisfies Prisma.ActivitySelect;

class AuditService {
  constructor(private readonly db: DbClient = prisma) {}

  private async page(where: Prisma.ActivityWhereInput, page: number, pageSize: number): Promise<AuditListResult> {
    const [totalItems, rows] = await Promise.all([
      this.db.activity.count({ where }),
      this.db.activity.findMany({
        where,
        select: AUDIT_SELECT,
        // id breaks ties so pages never repeat or skip rows created in the same instant.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // The `order` relation resolves via the `orderId` column, which is null on rows written before
    // the E6.6 Audit Trail added it - even though their referenceType/referenceId already point at a
    // real order. One extra batched lookup (not one per row) fills the order link in for those.
    const legacyOrderIds = [...new Set(rows.filter((r) => !r.order && r.referenceType === ORDER_REFERENCE_TYPE && r.referenceId).map((r) => r.referenceId!))];
    const legacyOrders = legacyOrderIds.length
      ? await this.db.order.findMany({ where: { id: { in: legacyOrderIds } }, select: { id: true, orderNumber: true, externalNumber: true } })
      : [];
    const legacyOrderById = new Map(legacyOrders.map((o) => [o.id, o]));

    return {
      items: rows.map((row) => mapAuditEntry({ ...row, order: row.order ?? legacyOrderById.get(row.referenceId ?? "") ?? null })),
      pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
    };
  }

  async listAudit(user: AuthUser, query: ListAuditQuery): Promise<AuditListResult> {
    const leadScope = await getLeadScope(user, this.db);
    const where = buildAuditWhere(query, leadScope);
    return this.page(where, query.page, query.pageSize);
  }

  async getOrderAudit(user: AuthUser, orderId: string, query: EntityAuditQuery): Promise<AuditListResult> {
    const leadScope = await getLeadScope(user, this.db);
    // Out-of-scope orders look the same as missing ones so ids can't be probed.
    const order = await this.db.order.findFirst({ where: scopedOrderWhere(orderId, leadScope), select: { id: true } });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);

    return this.page(orderAuditWhere(orderId), query.page, query.pageSize);
  }

  async getCustomerAudit(user: AuthUser, leadId: string, query: EntityAuditQuery): Promise<AuditListResult> {
    const leadScope = await getLeadScope(user, this.db);
    const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(leadId, leadScope), select: { id: true } });
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);

    return this.page({ leadId }, query.page, query.pageSize);
  }
}

export default AuditService;
