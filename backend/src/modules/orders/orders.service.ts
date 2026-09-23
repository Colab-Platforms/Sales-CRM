import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, Role, UserStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { getLeadScope, getManagerTeam, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { scopedLeadWhere } from "../customers/customers.filters.js";
import { deriveReconciliationStatus } from "../reconciliation/reconciliation.filters.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig, ShopifyConfigError } from "../shopify/shopify.config.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { createShopifyOrder, ShopifyOrderCreateError, type ShopifyOrderCreateInput } from "../shopify/shopify.orders.write.js";
import {
  buildOrderWhere,
  computePaymentBreakdown,
  derivePaymentMode,
  derivePaymentStatus,
  fullName,
  scopedOrderWhere,
} from "./orders.filters.js";
import {
  ORDER_REFERENCE_TYPE,
  type CreateManualOrderInput,
  type CreateManualOrderResult,
  type ListOrdersQuery,
  type OrderDetail,
  type OrderFilterOptions,
  type OrderListResult,
  type OrderStatusHistory,
  type ShopifyPushResult,
  type StatusHistoryEntry,
} from "./orders.types.js";

// Distinct "CRM-" prefix so a manually-entered order's number is never confused with a Shopify one
// ("SHP-<name>") at a glance, in the UI or in a support conversation - same generator shape as
// generateLeadNumber (@/utils/leadNumber.js).
function generateManualOrderNumber(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `CRM-${timestamp}-${random}`;
}

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

// ORDER_STATUS_CHANGED is the more specific type the E6.6 Audit Trail now writes for order status
// transitions going forward; STATUS_CHANGE is kept so historical rows still render. ORDER_CANCELLED
// is deliberately NOT included: cancellation already has its own unconditional RECORD milestone
// below (from order.cancelledAt), so mapping it here would show every cancellation twice.
const HISTORY_ACTIVITY_TYPES = [
  ActivityType.ORDER_CREATED,
  ActivityType.ORDER_CONFIRMED,
  ActivityType.STATUS_CHANGE,
  ActivityType.ORDER_STATUS_CHANGED,
];

const ACTIVITY_EVENT = {
  [ActivityType.ORDER_CREATED]: { event: "CREATED", title: "Order created" },
  [ActivityType.ORDER_CONFIRMED]: { event: "CONFIRMED", title: "Order confirmed" },
  [ActivityType.ORDER_STATUS_CHANGED]: { event: "STATUS_CHANGE", title: "Status changed" },
  [ActivityType.STATUS_CHANGE]: { event: "STATUS_CHANGE", title: "Status changed" },
} as const;

class OrdersService {
  // getShopifyClient is injectable so tests never construct a real client (which would read real
  // env credentials) - same "factory the constructor can override" shape as WhatsAppMessagingService's
  // getProvider. Wrapped in a function (not a stored instance) so a missing/bad config is only ever
  // discovered at the moment a Shopify push is actually attempted, not at service construction.
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getShopifyClient: () => ShopifyClient = () => new ShopifyClient(loadShopifyConfig()),
  ) {}

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

    const totalCents = toCents(order.totalAmount.toString());
    const breakdown = computePaymentBreakdown(order.payments);
    const outstandingCents = Math.max(totalCents - breakdown.paidCents - breakdown.refundedCents, 0);

    // The same parcel can be reported twice: by Shopify's fulfilment and by a shipment the CRM created directly in
    // Shiprocket. They stay separate rows (each source owns its own), and are tied together here by AWB.
    const normalizeAwb = (awb: string) => awb.trim().toUpperCase();
    const directByAwb = new Map(
      order.shipments.filter((s) => s.externalSource === "SHIPROCKET" && s.trackingNumber).map((s) => [normalizeAwb(s.trackingNumber!), s.id] as const),
    );

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
      paidAmount: fromCents(breakdown.paidCents),
      refundedAmount: fromCents(breakdown.refundedCents),
      outstandingAmount: fromCents(outstandingCents),
      reconciliationStatus: deriveReconciliationStatus(totalCents, breakdown, order.payments.length > 0),
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
        source: payment.externalSource,
        paymentUrl: payment.paymentUrl,
        paymentExpiresAt: payment.paymentExpiresAt,
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
        source: shipment.externalSource,
        providerStatus: shipment.providerStatus,
        labelUrl: shipment.labelUrl,
        pickupScheduledAt: shipment.pickupScheduledAt,
        shiprocketOrderId: shipment.providerOrderId,
        linkedShipmentId: shipment.externalSource === "SHOPIFY" && shipment.trackingNumber ? (directByAwb.get(normalizeAwb(shipment.trackingNumber)) ?? null) : null,
      })),
    };
  }

  // E7.8 (WhatsApp -> CRM Order): the CRM's one and only manual order-entry path - used by the
  // WhatsApp Inbox's "Create Order" action, but not specific to it; any caller with a lead in scope
  // can use it. Writes the exact same Order/OrderItem/Payment rows every other order path
  // (Shopify sync) writes, so it appears through listOrders/getOrder/Customer 360 automatically -
  // there is no separate WhatsApp-only order record. source: SALESPERSON marks it as staff-entered,
  // the same value a human-created order already used before this method existed.
  async createManualOrder(user: AuthUser, input: CreateManualOrderInput): Promise<CreateManualOrderResult> {
    const leadScope = await getLeadScope(user, this.db);
    const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(input.leadId, leadScope), select: { id: true } });
    // Out-of-scope reads the same as missing, same convention as every other single-lead lookup.
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);

    const productIds = [...new Set(input.items.map((i) => i.productId))];
    const products = await this.db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, sku: true, variants: { select: { id: true, name: true, sku: true } } },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    const itemRows = input.items.map((item) => {
      const product = productById.get(item.productId);
      if (!product) throw new ApiError(`Product not found: ${item.productId}`, STATUS_CODES.BAD_REQUEST);
      const variant = item.variantId ? product.variants.find((v) => v.id === item.variantId) : undefined;
      if (item.variantId && !variant) throw new ApiError(`Variant not found on this product: ${item.variantId}`, STATUS_CODES.BAD_REQUEST);

      const lineTotalCents = toCents(item.unitPrice) * item.quantity - toCents(item.discountAmount);
      return {
        id: randomUUID(),
        productId: product.id,
        variantId: variant?.id ?? null,
        productNameSnapshot: product.name,
        variantNameSnapshot: variant?.name ?? null,
        skuSnapshot: variant?.sku ?? product.sku ?? null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount ?? "0",
        taxAmount: "0",
        totalPrice: fromCents(Math.max(lineTotalCents, 0)),
      };
    });

    const subtotalCents = itemRows.reduce((sum, r) => sum + toCents(r.unitPrice) * r.quantity, 0);
    const itemDiscountCents = itemRows.reduce((sum, r) => sum + toCents(r.discountAmount), 0);
    const orderDiscountCents = toCents(input.discountAmount);
    const shippingCents = toCents(input.shippingAmount);
    const totalCents = Math.max(subtotalCents - itemDiscountCents - orderDiscountCents + shippingCents, 0);

    const isCod = input.paymentMethod === "COD";
    const now = new Date();
    const orderId = randomUUID();

    // Same "generate, try, retry on the rare collision" idiom as createLeadWithUniqueNumber -
    // orderNumber is @unique, so a clash (astronomically unlikely, but real) must never 500.
    let createdOrderId: string | null = null;
    for (let attempt = 0; attempt < 5 && !createdOrderId; attempt++) {
      try {
        await this.db.$transaction(async (tx) => {
          await tx.order.create({
            data: {
              id: orderId,
              orderNumber: generateManualOrderNumber(),
              leadId: lead.id,
              createdById: user.id,
              source: "SALESPERSON",
              status: isCod ? "CONFIRMED" : "PENDING_PAYMENT",
              subtotal: fromCents(subtotalCents),
              discountAmount: fromCents(itemDiscountCents + orderDiscountCents),
              taxAmount: "0",
              shippingAmount: input.shippingAmount ?? "0",
              totalAmount: fromCents(totalCents),
              discountReason: input.discountReason,
              shippingAddress: input.shippingAddress ?? undefined,
              shippingPincode: input.shippingPincode ?? input.shippingAddress?.pincode,
              // Free-form, existing field (Order.metadata) - never a new column. paymentMode mirrors
              // the exact same derived value Shopify-synced orders already carry (shopify.mapper.ts).
              metadata: { paymentMode: isCod ? "COD" : "PREPAID", createdVia: "WHATSAPP_INBOX" },
              placedAt: now,
              confirmedAt: isCod ? now : null,
              items: { createMany: { data: itemRows } },
              payments: { create: { amount: fromCents(totalCents), currency: "INR", method: input.paymentMethod, status: "PENDING" } },
            },
          });
          await tx.activity.create({
            data: {
              leadId: lead.id,
              orderId,
              actorId: user.id,
              actorRole: user.role,
              type: ActivityType.ORDER_CREATED,
              referenceType: ORDER_REFERENCE_TYPE,
              referenceId: orderId,
              source: ActivitySource.USER,
              title: "Order created from WhatsApp Inbox",
            },
          });
        });
        createdOrderId = orderId;
      } catch (error: any) {
        if (error?.code === "P2002" && attempt < 4) continue; // orderNumber collision - retry with a new one
        throw error;
      }
    }
    if (!createdOrderId) throw new ApiError("Failed to generate a unique order number", STATUS_CODES.SERVER_ERROR);

    // Best-effort, immediately after: the CRM order is already durably committed above regardless of
    // what happens here. A Shopify failure is reported, never hidden, and never rolls back or
    // duplicates the CRM order - retrying just calls pushOrderToShopify again (see there for why
    // that's always safe).
    const shopify = await this.pushOrderToShopify(user, createdOrderId);
    const order = await this.getOrder(user, createdOrderId);
    return { order, shopify };
  }

  // Pushes an already-created CRM order to Shopify via the Admin GraphQL orderCreate mutation - the
  // one and only Shopify write in this codebase (shopify.sync.ts/shopify.orders.ts stay read-only).
  // Idempotent by construction: once externalId is set, this only ever returns "already_linked" and
  // never calls Shopify again - the safe way to let a caller "retry" after a failure without ever
  // creating a second Shopify order for the same CRM order.
  async pushOrderToShopify(user: AuthUser, orderId: string): Promise<ShopifyPushResult> {
    const leadScope = await getLeadScope(user, this.db);
    const order = await this.db.order.findFirst({
      where: scopedOrderWhere(orderId, leadScope),
      select: {
        id: true,
        orderNumber: true,
        currency: true,
        externalSource: true,
        externalId: true,
        externalNumber: true,
        shippingAddress: true,
        shippingPincode: true,
        lead: { select: { firstName: true, lastName: true, mobile: true, normalizedMobile: true, email: true } },
        items: {
          select: {
            quantity: true,
            unitPrice: true,
            productNameSnapshot: true,
            product: { select: { externalId: true } },
            variant: { select: { externalId: true } },
          },
        },
        payments: { select: { method: true, status: true }, orderBy: { createdAt: "asc" }, take: 1 },
      },
    });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);

    if (order.externalId) {
      // Already linked - whether by this same push earlier, or because the order actually came FROM
      // Shopify sync in the first place. Either way, never create a second Shopify order for it.
      return { status: "already_linked", shopifyOrderId: order.externalId, shopifyOrderName: order.externalNumber ?? undefined };
    }

    let client: ShopifyClient;
    try {
      client = this.getShopifyClient();
    } catch (error) {
      if (error instanceof ShopifyConfigError) return { status: "failed", reason: error.message };
      throw error;
    }

    const address = (order.shippingAddress ?? {}) as Record<string, string | null | undefined>;
    const shippingAddress: ShopifyOrderCreateInput["shippingAddress"] = order.shippingAddress
      ? {
          firstName: order.lead.firstName,
          lastName: order.lead.lastName ?? undefined,
          address1: address.line1 ?? undefined,
          address2: address.line2 ?? undefined,
          city: address.city ?? undefined,
          province: address.state ?? undefined,
          zip: address.pincode ?? order.shippingPincode ?? undefined,
          country: "IN",
          phone: address.phone ?? order.lead.normalizedMobile ?? undefined,
        }
      : undefined;

    const input: ShopifyOrderCreateInput = {
      lineItems: order.items.map((item) =>
        item.variant?.externalId
          ? { variantId: item.variant.externalId, quantity: item.quantity }
          : { title: item.productNameSnapshot, quantity: item.quantity, priceAmount: item.unitPrice.toString() },
      ),
      email: order.lead.email ?? undefined,
      phone: order.lead.normalizedMobile ?? undefined,
      currency: order.currency,
      // Reflects the CRM's own recorded payment status, not the payment METHOD - a not-yet-collected
      // prepaid order is exactly as unpaid as a COD one until a payment actually succeeds.
      financialStatus: order.payments[0]?.status === "SUCCESS" ? "PAID" : "PENDING",
      note: `Created in the CRM (${order.orderNumber}) via the WhatsApp Inbox.`,
      shippingAddress,
    };

    try {
      const result = await createShopifyOrder(client, input);
      // Guarded by the same id + "still unlinked" condition just checked above, so two concurrent
      // pushes can never both win and create two Shopify orders for this one CRM order.
      const { count } = await this.db.order.updateMany({
        where: { id: orderId, externalId: null },
        data: { externalSource: "SHOPIFY", externalId: result.shopifyOrderId, externalNumber: result.shopifyOrderName, externalUpdatedAt: new Date() },
      });
      if (count === 0) {
        // Lost a race to a concurrent push that already linked it - report that one, not a phantom second order.
        const linked = await this.db.order.findUniqueOrThrow({ where: { id: orderId }, select: { externalId: true, externalNumber: true } });
        return { status: "already_linked", shopifyOrderId: linked.externalId!, shopifyOrderName: linked.externalNumber ?? undefined };
      }
      return { status: "created", shopifyOrderId: result.shopifyOrderId, shopifyOrderName: result.shopifyOrderName };
    } catch (error) {
      if (error instanceof ShopifyOrderCreateError) return { status: "failed", reason: error.message };
      throw error;
    }
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
