import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivityType, Role, UserStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { getLeadScope, getManagerTeam, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { buildOrderWhere, derivePaymentMode, derivePaymentStatus, fullName, scopedOrderWhere } from "./orders.filters.js";
import {
  ORDER_REFERENCE_TYPE,
  type ListOrdersQuery,
  type OrderDetail,
  type OrderFilterOptions,
  type OrderListResult,
  type OrderStatusHistory,
  type StatusHistoryEntry,
} from "./orders.types.js";

const LIST_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  source: true,
  currency: true,
  totalAmount: true,
  externalNumber: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
  lead: {
    select: {
      id: true,
      leadNumber: true,
      firstName: true,
      lastName: true,
      source: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true } },
    },
  },
  payments: { select: { status: true, method: true } },
  _count: { select: { items: true } },
} satisfies Prisma.OrderSelect;

const DETAIL_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  source: true,
  currency: true,
  subtotal: true,
  discountAmount: true,
  taxAmount: true,
  shippingAmount: true,
  totalAmount: true,
  discountReason: true,
  externalNumber: true,
  shippingAddress: true,
  shippingPincode: true,
  cancelReason: true,
  createdAt: true,
  placedAt: true,
  confirmedAt: true,
  cancelledAt: true,
  createdBy: { select: { id: true, name: true, email: true } },
  lead: {
    select: {
      id: true,
      leadNumber: true,
      firstName: true,
      lastName: true,
      mobile: true,
      email: true,
      source: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true } },
    },
  },
  items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
  payments: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
  shipments: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
} satisfies Prisma.OrderSelect;

const HISTORY_ACTIVITY_TYPES = [ActivityType.ORDER_CREATED, ActivityType.ORDER_CONFIRMED, ActivityType.STATUS_CHANGE];

const ACTIVITY_EVENT = {
  [ActivityType.ORDER_CREATED]: { event: "CREATED", title: "Order created" },
  [ActivityType.ORDER_CONFIRMED]: { event: "CONFIRMED", title: "Order confirmed" },
  [ActivityType.STATUS_CHANGE]: { event: "STATUS_CHANGE", title: "Status changed" },
} as const;

class OrdersService {
  constructor(private readonly db: DbClient = prisma) {}

  async listOrders(user: AuthUser, query: ListOrdersQuery): Promise<OrderListResult> {
    const leadScope = await getLeadScope(user, this.db);
    const where = buildOrderWhere(query, leadScope);

    const [totalItems, rows] = await Promise.all([
      this.db.order.count({ where }),
      this.db.order.findMany({
        where,
        select: LIST_SELECT,
        // id breaks ties so pages never repeat or skip rows created in the same instant.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items: rows.map((order) => {
        const salesperson = order.createdBy ?? order.lead.owner;
        return {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          source: order.source,
          currency: order.currency,
          totalAmount: order.totalAmount.toString(),
          itemCount: order._count.items,
          paymentStatus: derivePaymentStatus(order.payments),
          paymentMode: derivePaymentMode(order.payments),
          externalNumber: order.externalNumber,
          createdAt: order.createdAt,
          customer: {
            leadId: order.lead.id,
            leadNumber: order.lead.leadNumber,
            name: fullName(order.lead.firstName, order.lead.lastName),
          },
          salesperson: salesperson ? { id: salesperson.id, name: salesperson.name } : null,
          leadSource: order.lead.source,
        };
      }),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }

  async getOrder(user: AuthUser, id: string): Promise<OrderDetail> {
    const leadScope = await getLeadScope(user, this.db);
    const order = await this.db.order.findFirst({
      where: scopedOrderWhere(id, leadScope),
      select: DETAIL_SELECT,
    });

    // Out-of-scope orders look the same as missing ones so ids can't be probed.
    if (!order) {
      throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    }

    const money = (value: Prisma.Decimal) => value.toString();

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      source: order.source,
      currency: order.currency,
      subtotal: money(order.subtotal),
      discountAmount: money(order.discountAmount),
      taxAmount: money(order.taxAmount),
      shippingAmount: money(order.shippingAmount),
      totalAmount: money(order.totalAmount),
      discountReason: order.discountReason,
      externalNumber: order.externalNumber,
      shippingAddress: (order.shippingAddress as Record<string, string | null> | null) ?? null,
      shippingPincode: order.shippingPincode,
      cancelReason: order.cancelReason,
      createdAt: order.createdAt,
      placedAt: order.placedAt,
      confirmedAt: order.confirmedAt,
      cancelledAt: order.cancelledAt,
      paymentStatus: derivePaymentStatus(order.payments),
      paymentMode: derivePaymentMode(order.payments),
      customer: {
        leadId: order.lead.id,
        leadNumber: order.lead.leadNumber,
        name: fullName(order.lead.firstName, order.lead.lastName),
        mobile: order.lead.mobile,
        email: order.lead.email,
      },
      leadSource: order.lead.source,
      bookedBy: order.createdBy,
      leadOwner: order.lead.owner,
      items: order.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        productName: item.productNameSnapshot,
        variantName: item.variantNameSnapshot,
        sku: item.skuSnapshot,
        quantity: item.quantity,
        unitPrice: money(item.unitPrice),
        discountAmount: money(item.discountAmount),
        taxAmount: money(item.taxAmount),
        totalPrice: money(item.totalPrice),
      })),
      payments: order.payments.map((payment) => ({
        id: payment.id,
        status: payment.status,
        method: payment.method,
        amount: money(payment.amount),
        currency: payment.currency,
        provider: payment.provider,
        providerPaymentId: payment.providerPaymentId,
        transactionReference: payment.transactionReference,
        paidAt: payment.paidAt,
        failedAt: payment.failedAt,
        refundedAt: payment.refundedAt,
        refundedAmount: payment.refundedAmount ? money(payment.refundedAmount) : null,
        failureReason: payment.failureReason,
        createdAt: payment.createdAt,
      })),
      shipments: order.shipments.map((shipment) => ({
        id: shipment.id,
        status: shipment.status,
        courier: shipment.courier,
        trackingNumber: shipment.trackingNumber,
        trackingUrl: shipment.trackingUrl,
        shippedAt: shipment.shippedAt,
        expectedDeliveryAt: shipment.expectedDeliveryAt,
        deliveredAt: shipment.deliveredAt,
        returnedAt: shipment.returnedAt,
        createdAt: shipment.createdAt,
      })),
    };
  }

  // Foundation only: there is no status-history table yet, so this combines recorded
  // Activity rows that point at the order with the milestone timestamps on the order row.
  // Neither stores the previous/new status, which needs a schema change (see E6 notes).
  async getStatusHistory(user: AuthUser, id: string): Promise<OrderStatusHistory> {
    const leadScope = await getLeadScope(user, this.db);
    const order = await this.db.order.findFirst({
      where: scopedOrderWhere(id, leadScope),
      select: {
        id: true,
        orderNumber: true,
        status: true,
        createdAt: true,
        placedAt: true,
        confirmedAt: true,
        cancelledAt: true,
      },
    });

    if (!order) {
      throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    }

    const activities = await this.db.activity.findMany({
      where: {
        referenceType: ORDER_REFERENCE_TYPE,
        referenceId: order.id,
        type: { in: HISTORY_ACTIVITY_TYPES },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        type: true,
        title: true,
        description: true,
        createdAt: true,
        actor: { select: { id: true, name: true } },
      },
    });

    const entries: StatusHistoryEntry[] = activities.map((activity) => {
      const meta = ACTIVITY_EVENT[activity.type as keyof typeof ACTIVITY_EVENT];
      return {
        id: activity.id,
        event: meta.event,
        title: activity.title ?? meta.title,
        description: activity.description,
        occurredAt: activity.createdAt,
        actor: activity.actor,
        source: "ACTIVITY",
      };
    });

    const recorded = new Set(activities.map((a) => a.type));
    const milestone = (event: StatusHistoryEntry["event"], title: string, occurredAt: Date | null) => {
      if (occurredAt) {
        entries.push({
          id: `${order.id}:${event}`,
          event,
          title,
          description: null,
          occurredAt,
          actor: null,
          source: "ORDER_RECORD",
        });
      }
    };

    if (!recorded.has(ActivityType.ORDER_CREATED)) milestone("CREATED", "Order created", order.createdAt);
    milestone("PLACED", "Order placed", order.placedAt);
    if (!recorded.has(ActivityType.ORDER_CONFIRMED)) milestone("CONFIRMED", "Order confirmed", order.confirmedAt);
    milestone("CANCELLED", "Order cancelled", order.cancelledAt);

    entries.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      currentStatus: order.status,
      entries,
    };
  }

  // People the user may filter orders by. Salespeople only ever see their own orders,
  // so they get no list.
  async getFilterOptions(user: AuthUser): Promise<OrderFilterOptions> {
    if (user.role === Role.SALESPERSON) {
      return { salespeople: [] };
    }

    if (user.role === Role.ADMIN) {
      const users = await this.db.user.findMany({
        where: { role: { in: [Role.SALESPERSON, Role.MANAGER] } },
        select: { id: true, name: true, status: true },
        orderBy: { name: "asc" },
      });
      return {
        salespeople: users.map((u) => ({
          id: u.id,
          name: u.status === UserStatus.ACTIVE ? u.name : `${u.name} (inactive)`,
        })),
      };
    }

    const team = await getManagerTeam(user.id, this.db);
    const self = await this.db.user.findUnique({ where: { id: user.id }, select: { id: true, name: true } });
    const people = new Map(team.members.map((m) => [m.id, m]));
    if (self) people.set(self.id, self);

    return { salespeople: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }
}

export default OrdersService;
