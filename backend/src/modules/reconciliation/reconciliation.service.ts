import { prisma } from "@/lib/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { computePaymentBreakdown, derivePaymentMode } from "../orders/orders.filters.js";
import { toCents } from "../shopify/shopify.money.js";
import {
  buildReconciliationSummary,
  buildReconciliationWhere,
  deriveReconciliationStatus,
  mapReconciliationRow,
} from "./reconciliation.filters.js";
import type { ListReconciliationQuery, ReconciliationResult } from "./reconciliation.types.js";

const RECONCILIATION_SELECT = {
  id: true,
  orderNumber: true,
  externalNumber: true,
  createdAt: true,
  currency: true,
  totalAmount: true,
  discountAmount: true,
  lead: { select: { id: true, leadNumber: true, firstName: true, lastName: true } },
  payments: {
    select: {
      status: true,
      method: true,
      amount: true,
      refundedAmount: true,
      provider: true,
      transactionReference: true,
      createdAt: true,
    },
  },
} satisfies Prisma.OrderSelect;

class ReconciliationService {
  constructor(private readonly db: DbClient = prisma) {}

  // paymentMode and reconciliationStatus are derived from each order's payments rather than stored
  // columns, so - like the rest of this financial view - they can't be pushed into the database
  // query. At today's order volume (thousands, not millions) fetching every order that matches the
  // database-level filters and deriving/filtering/paginating in memory is simple and correct; if
  // order volume grows by orders of magnitude this would need a materialized reconciliation column.
  async getReconciliation(user: AuthUser, query: ListReconciliationQuery): Promise<ReconciliationResult> {
    const leadScope = await getLeadScope(user, this.db);
    const where = buildReconciliationWhere(query, leadScope);

    const orders = await this.db.order.findMany({
      where,
      select: RECONCILIATION_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const filtered = orders.filter((order) => {
      if (query.paymentMode && derivePaymentMode(order.payments) !== query.paymentMode) return false;
      if (query.reconciliationStatus) {
        const totalCents = toCents(order.totalAmount.toString());
        const breakdown = computePaymentBreakdown(order.payments);
        const status = deriveReconciliationStatus(totalCents, breakdown, order.payments.length > 0);
        if (status !== query.reconciliationStatus) return false;
      }
      return true;
    });

    const summary = buildReconciliationSummary(filtered);

    const totalItems = filtered.length;
    const start = (query.page - 1) * query.pageSize;
    const pageOrders = filtered.slice(start, start + query.pageSize);

    return {
      summary,
      items: pageOrders.map(mapReconciliationRow),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }
}

export default ReconciliationService;
