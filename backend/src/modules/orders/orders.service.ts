import { randomUUID } from "node:crypto";
import { resolveAddressForLead, type AddressSource, type ResolvedAddress } from "./orders.address-resolver.js";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, OrderStatus, Role, UserStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { getLeadScope, getManagerTeam, getOrderFlowScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { scopedLeadWhere } from "../customers/customers.filters.js";
import { deriveReconciliationStatus } from "../reconciliation/reconciliation.filters.js";
import { ShopifyApiError, ShopifyClient } from "../shopify/shopify.client.js";
import { hashOrderRequest, IDEMPOTENCY_COMPLETED, IDEMPOTENCY_ORDER_CREATED, idempotencyTuning, IdempotencyRaceLost, ORDER_CREATE_OPERATION, sleep } from "./orders.idempotency.js";
import { loadShopifyConfig, ShopifyConfigError } from "../shopify/shopify.config.js";
import { fromCents, normalizeShopifyOrderId, toCents } from "../shopify/shopify.money.js";
import { toShopifyOrderGid } from "../shopify/shopify.orders.write.js";
import { fetchOrder as fetchShopifyOrder, type NormalizedOrder } from "../shopify/shopify.orders.js";
import { sanitizeSyncError, syncAdvice } from "../shopify/shopify.sync-status.js";
import type { ShopifySyncRecord } from "./orders.types.js";
import { buildShopifyOrderPayload, type CrmOrderForShopify } from "../shopify/shopify.order-mapping.js";
import { resolveShopifyCustomer } from "../shopify/shopify.order-customer.js";
import { addShopifyOrderTags, repairShopifyOrderFields, verifyShopifyOrder, cancelShopifyOrder, createShopifyOrder, findShopifyOrderBySourceIdentifier, isShopifyRejection, ShopifyOrderCancelError, ShopifyOrderCreateError, type ShopifyOrderCreateInput } from "../shopify/shopify.orders.write.js";
import { computePercentDiscount } from "./orders.discount.js";
import { ABANDONMENT_WORK_ROLES, abandonmentLeadScope } from "../abandonment/abandonment.filters.js";
import { UUID_PATTERN } from "../integrations/integrations.common.js";
import DiscountsService, { type ResolvedDiscount } from "../discounts/discounts.service.js";
import { clearLiveOrderCaches } from "./orders.live.service.js";
import { shippingChargeCents } from "./orders.shipping.js";
import { getLiveTrackingBatch } from "../shiprocket/shiprocket.live-tracking.js";
import type { LiveTracking } from "../shiprocket/shiprocket.types.js";
import CashfreePaymentsService from "../cashfree/cashfree.payments.service.js";
import { getWhatsAppPaymentOptions, recordWhatsAppConsent, validateWhatsAppPaymentSend, type WhatsAppPaymentOptions } from "./orders.whatsapp-payment.js";
import { confirmationTagFor, recordConfirmation, syncConfirmationTag, type ConfirmationTagSyncResult } from "./orders.confirmation.js";
import { creatorOf, creatorTagFor, resolveCreatorSnapshot, syncCreatorTag, type CreatorTagSyncResult } from "./orders.creator-tag.js";
import { syncShopifyPayment, type ShopifyPaymentSyncResult } from "../cashfree/cashfree.payment-success.js";
import { notifyOrderConfirmation, notifyPaymentLink, recordOrderNotification, type OrderNotifyResult } from "../whatsapp/whatsapp.order-notify.service.js";
import { loadOrderRefundInfo } from "../refunds/refunds.service.js";
import {
  buildOrderWhere,
  computePaymentBreakdown,
  derivePaymentMode,
  derivePaymentStatus,
  fullName,
  orderReadWhere,
  orderVisibilityScope,
  scopedOrderWhere,
} from "./orders.filters.js";
import {
  ORDER_REFERENCE_TYPE,
  type CancelOrderInput,
  type CancelOrderResult,
  type RevertCancellationResult,
  type CreateManualOrderInput,
  type CreateManualOrderResult,
  type ListOrdersQuery,
  type OrderDetail,
  type OrderFilterOptions,
  type OrderListResult,
  type OrderPaymentLinkResult,
  type OrderWhatsAppNotification,
  type PaymentLinkCancelResult,
  type OrderStatusHistory,
  type ShopifyCancelResult,
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

// Live Shopify snapshot for Order Detail - additive overlay only, never replaces the CRM's own order
// record above. Same in-process TTL Map idiom as orders.live.service.ts; not RBAC-sensitive (the
// caller already passed the CRM's own lead-scope check to load the order in the first place), so the
// cache key is just the order's externalId.
interface ShopifyLiveOrderResult {
  order: NormalizedOrder | null;
  error?: string;
}
const SHOPIFY_LIVE_ORDER_TTL_MS = 30_000;
const shopifyLiveOrderCache = new Map<string, { value: ShopifyLiveOrderResult; expiresAt: number }>();

async function fetchShopifyLiveOrder(externalSource: string | null, externalId: string | null): Promise<ShopifyLiveOrderResult> {
  if (externalSource !== "SHOPIFY" || !externalId) return { order: null };

  const cacheKey = normalizeShopifyOrderId(externalId);
  const cached = shopifyLiveOrderCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let result: ShopifyLiveOrderResult;
  try {
    const client = new ShopifyClient(loadShopifyConfig());
    const order = await fetchShopifyOrder(client, toShopifyOrderGid(externalId));
    result = { order };
  } catch (error) {
    result = {
      order: null,
      error: error instanceof ShopifyConfigError ? "Shopify is not configured" : "Could not reach Shopify for live order details",
    };
  }

  shopifyLiveOrderCache.set(cacheKey, { value: result, expiresAt: Date.now() + SHOPIFY_LIVE_ORDER_TTL_MS });
  return result;
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
  externalSource: true,
  externalId: true,
  externalNumber: true,
  shippingAddress: true,
  shippingPincode: true,
  parcelWeightKg: true,
  cancelReason: true,
  metadata: true,
  createdAt: true,
  placedAt: true,
  confirmedAt: true,
  cancelledAt: true,
  confirmedByUserId: true,
  confirmedByName: true,
  createdBy: { select: { id: true, name: true, username: true } },
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
  // The catalog weights ride along only so the shipment dialog can SUGGEST a parcel weight for an order that has none recorded.
  items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { product: { select: { weightKg: true, lengthCm: true, widthCm: true, heightCm: true } }, variant: { select: { weightKg: true, lengthCm: true, widthCm: true, heightCm: true } } } },
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

// The two Cashfree operations orders need: create a link (prepaid order) and cancel an unpaid one (order cancellation).
type CashfreeOps = Pick<CashfreePaymentsService, "createPaymentLink" | "cancelPaymentLink">;

// The customer-facing item lines for WhatsApp: product name (+ variant) and quantity only - never an internal id.
const messageItems = (order: { items: { productName: string; variantName: string | null; quantity: number }[] }) =>
  order.items.map((i) => ({ name: i.productName, variant: i.variantName, quantity: i.quantity }));

// A CRM-created Cashfree payment link that is still payable (not settled, not failed/cancelled/expired).
const isOpenCashfreeLink = (p: { status: string; externalSource: string | null }): boolean => p.externalSource === "CASHFREE" && (p.status === "PENDING" || p.status === "PROCESSING");

// What has happened to an order's Cashfree link(s), derived from the Payment rows themselves (no extra stored flag): a
// link cancelled through Cashfree is recorded by cancelPaymentLink as FAILED "Payment link cancelled". "paid" is
// informational - a successful payment is left exactly as it is (no refund is implied by a cancellation).
function summarizePaymentLink(payments: { status: string; externalSource: string | null; failureReason: string | null }[], prior?: { status: PaymentLinkCancelResult["status"]; reason?: string }): PaymentLinkCancelResult {
  if (payments.some(isOpenCashfreeLink)) return { status: "failed", reason: prior?.reason ?? "The Cashfree payment link is still active." };
  if (payments.some((p) => p.status === "SUCCESS")) return { status: "paid" };
  if (payments.some((p) => p.externalSource === "CASHFREE" && p.failureReason === "Payment link cancelled")) return { status: "cancelled" };
  return { status: "none" };
}

const unitDims = (r: { lengthCm: { toString(): string } | null; widthCm: { toString(): string } | null; heightCm: { toString(): string } | null }) =>
  r.lengthCm && r.widthCm && r.heightCm ? { lengthCm: r.lengthCm.toString(), widthCm: r.widthCm.toString(), heightCm: r.heightCm.toString() } : null;

const SHOPIFY_PUSH_SELECT = {
    id: true,
    orderNumber: true,
    currency: true,
    discountAmount: true,
    subtotal: true,
    shippingAmount: true,
    taxAmount: true,
    totalAmount: true,
    metadata: true,
    externalSource: true,
    externalId: true,
    externalNumber: true,
    shippingAddress: true,
    shippingPincode: true,
    discountReason: true,
    conversation: { select: { id: true } },
    lead: { select: { firstName: true, lastName: true, leadNumber: true, mobile: true, normalizedMobile: true, email: true } },
    items: {
      select: {
        quantity: true,
        unitPrice: true,
        productNameSnapshot: true,
        variantNameSnapshot: true,
        skuSnapshot: true,
        product: { select: { externalId: true, type: true } },
        variant: { select: { externalId: true, externalSource: true } },
      },
    },
    payments: { select: { method: true, status: true }, orderBy: { createdAt: "asc" }, take: 1 },
} as const satisfies Prisma.OrderSelect;
type PushOrder = Prisma.OrderGetPayload<{ select: typeof SHOPIFY_PUSH_SELECT }>;

/** The ONE place the Shopify payload for a CRM order is prepared - used by the first push, a retry and a re-sync, so they can never disagree. */
async function prepareShopifyPayload(order: PushOrder, client: ShopifyClient) {
    // Only when the CRM's own figures add up (items - discount + shipping + tax = total, and no tax that Shopify would not compute) can the Shopify order be made to match; otherwise it is created
    // exactly as before and NOT claimed to match, so the payment sync keeps its safe reconciliation (and refuses a mismatch).
    const cents = (v: { toString(): string }) => toCents(v.toString());
    const itemsCents = order.items.reduce((sum, i) => sum + cents(i.unitPrice) * i.quantity, 0);
    const crmFiguresAddUp = Number(order.taxAmount) === 0 && itemsCents === cents(order.subtotal) && itemsCents - cents(order.discountAmount) + cents(order.shippingAmount) === cents(order.totalAmount);
    const extras = crmFiguresAddUp && (cents(order.discountAmount) > 0 || cents(order.shippingAmount) > 0);

    // Which Shopify customer (if any) this order belongs to - verified on phone / real e-mail only; never guessed.
    const addressRecord = (order.shippingAddress ?? null) as Record<string, unknown> | null;
    const customerDecision = await resolveShopifyCustomer(client, order.lead, typeof addressRecord?.name === "string" ? addressRecord.name : null);

    // ONE mapping layer builds the whole payload (customer, shipping + billing address, items with shipping-required, discount, tags, note, metafields) - see shopify.order-mapping.ts.
    const crmForShopify: CrmOrderForShopify = {
      orderNumber: order.orderNumber,
      currency: order.currency,
      subtotal: order.subtotal.toString(),
      discountAmount: fromCents(cents(order.discountAmount)),
      discountReason: order.discountReason,
      shippingAmount: fromCents(cents(order.shippingAmount)),
      taxAmount: order.taxAmount.toString(),
      totalAmount: order.totalAmount.toString(),
      shippingAddress: addressRecord,
      shippingPincode: order.shippingPincode,
      metadata: (order.metadata as Record<string, unknown> | null) ?? null,
      paymentMethod: order.payments[0]?.method ?? null,
      paymentSucceeded: order.payments[0]?.status === "SUCCESS",
      settleAfterCreate: ((order.metadata as Record<string, unknown> | null)?.paymentMode) === "PREPAID",
      fromAiConversation: Boolean(order.conversation),
      lead: { firstName: order.lead.firstName, lastName: order.lead.lastName, leadNumber: order.lead.leadNumber, email: order.lead.email, normalizedMobile: order.lead.normalizedMobile, mobile: order.lead.mobile },
      items: order.items.map((item) => ({
        quantity: item.quantity,
        unitPrice: item.unitPrice.toString(),
        productName: item.productNameSnapshot,
        variantName: item.variantNameSnapshot,
        sku: item.skuSnapshot,
        // Only a variant that really came from Shopify has a Shopify variant id; anything else is sent as a custom line item.
        shopifyVariantId: item.variant?.externalId && item.variant.externalSource === "SHOPIFY" ? item.variant.externalId : null,
        physical: item.product?.type !== "SERVICE",
      })),
    };
    const built = buildShopifyOrderPayload(crmForShopify, { figuresMirror: Boolean(extras), customer: customerDecision.customer, customerNote: customerDecision.note });
    return { built, customerDecision, extras, crmFiguresAddUp, cents };
}

class OrdersService {
  // getShopifyClient is injectable so tests never construct a real client (which would read real
  // env credentials) - same "factory the constructor can override" shape as WhatsAppMessagingService's
  // getProvider. Wrapped in a function (not a stored instance) so a missing/bad config is only ever
  // discovered at the moment a Shopify push is actually attempted, not at service construction.
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getShopifyClient: () => ShopifyClient = () => new ShopifyClient(loadShopifyConfig()),
    // Its own independent instance (own default `prisma`, like getShopifyClient's own default config
    // loader) rather than sharing this.db - CashfreePaymentsService needs a real TxRunner (something
    // with $transaction), which a test's already-open `tx` (this.db) cannot safely provide nested. In
    // production this.db IS prisma, so the two are the same connection either way. Tests inject a fake.
    private readonly getCashfree: () => CashfreeOps = () => new CashfreePaymentsService(),
    // Real WhatsApp sends by default; tests inject trivial stubs so order-creation tests never touch
    // WhatsApp/Meta/template resolution at all.
    private readonly notify: { confirmation: typeof notifyOrderConfirmation; paymentLink: typeof notifyPaymentLink } = { confirmation: notifyOrderConfirmation, paymentLink: notifyPaymentLink },
  ) {}

  async listOrders(user: AuthUser, query: ListOrdersQuery): Promise<OrderListResult> {
    return this.listOrdersWhere(user, query);
  }

  /**
   * "My Orders": only the orders THIS user created (Order.createdById = the authenticated user), enforced in the database query. The id comes from the verified session and from
   * nothing else - no request parameter can name another creator, and every other filter can only narrow the result further. An order that was merely assigned to the user, or that belongs
   * to one of their customers, or that was synced from Shopify (no creator), is not included.
   */
  async listMyOrders(user: AuthUser, query: ListOrdersQuery): Promise<OrderListResult> {
    // Salesperson-only (the route enforces it too): the page exists for the people who create orders as part of their own work.
    if (user.role !== Role.SALESPERSON) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    return this.listOrdersWhere(user, query, { createdById: user.id });
  }

  private async listOrdersWhere(user: AuthUser, query: ListOrdersQuery, mustMatch?: Prisma.OrderWhereInput): Promise<OrderListResult> {
    const leadScope = await getLeadScope(user, this.db);
    const base = buildOrderWhere(query, orderVisibilityScope(user.role, leadScope));
    const where: Prisma.OrderWhereInput = mustMatch ? { AND: [base, mustMatch] } : base;

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

  /**
   * "View Customer Details" on an order opens the customer's ABANDONED LEAD page. Which one: the checkout this order was created from (Order.metadata.abandonment.id) when it still belongs to
   * this customer, otherwise the customer's most recent one. Only a checkout of THIS order's customer and inside THIS viewer's abandonment scope is ever returned (the same rule as the abandoned
   * leads queue); anything else is null and the page shows a clear message instead of opening somebody else's lead.
   */
  private async openableAbandonmentId(user: AuthUser, leadId: string, metadata: unknown): Promise<string | null> {
    if (!ABANDONMENT_WORK_ROLES.includes(user.role)) return null;
    const scope = abandonmentLeadScope(user);
    const where: Prisma.AbandonmentWhereInput = { leadId, ...(Object.keys(scope).length > 0 ? { lead: scope } : {}) };
    const fromOrder = (metadata as { abandonment?: { id?: unknown } } | null | undefined)?.abandonment?.id;
    if (typeof fromOrder === "string" && UUID_PATTERN.test(fromOrder)) {
      const exact = await this.db.abandonment.findFirst({ where: { ...where, id: fromOrder }, select: { id: true } });
      if (exact) return exact.id;
    }
    const latest = await this.db.abandonment.findFirst({ where, orderBy: [{ detectedAt: "desc" }, { createdAt: "desc" }], select: { id: true } });
    return latest?.id ?? null;
  }

  async getOrder(user: AuthUser, id: string, opts: { approverScope?: boolean } = {}): Promise<OrderDetail> {
    const leadScope = opts.approverScope ? {} : await getLeadScope(user, this.db);
    // orderReadWhere: every order is readable by admin, manager and salesperson, whichever team it belongs to (reading only; actions keep their own scope).
    const order = await this.db.order.findFirst({
      where: orderReadWhere(user, id, leadScope),
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

    // Both external lookups are independent of each other and of everything above (the CRM's own
    // data was already loaded) - fetch them in parallel rather than one after the other, and let
    // either fail on its own without affecting the CRM-owned data already assembled.
    const awbsToTrack = [...new Set(order.shipments.map((s) => s.trackingNumber).filter((awb): awb is string => Boolean(awb)))];
    const [shopifyLiveResult, liveTrackingByAwb] = await Promise.all([
      fetchShopifyLiveOrder(order.externalSource, order.externalId),
      awbsToTrack.length > 0 ? getLiveTrackingBatch(awbsToTrack) : Promise.resolve(new Map<string, LiveTracking>()),
    ]);

    const refunds = await loadOrderRefundInfo(this.db, order.id);

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
      parcelWeightKg: order.parcelWeightKg ? order.parcelWeightKg.toString() : null,
      cancelReason: order.cancelReason,
      // Last Shopify-cancellation outcome recorded by cancelOrder (Order.metadata) - lets the UI offer a retry after a reload.
      shopifyCancellation: ((order.metadata as Record<string, unknown> | null)?.shopifyCancellation as ShopifyCancelResult | undefined) ?? null,
      paymentLinkCancellation: ((order.metadata as Record<string, unknown> | null)?.paymentLinkCancellation as PaymentLinkCancelResult | undefined) ?? null,
      shopifyPaymentSync: ((order.metadata as Record<string, unknown> | null)?.shopifyPaymentSync as OrderDetail["shopifyPaymentSync"] | undefined) ?? null,
      whatsappNotification: ((order.metadata as Record<string, unknown> | null)?.whatsappNotification as OrderWhatsAppNotification | undefined) ?? null,
      confirmedBy: order.confirmedByUserId && order.confirmedByName ? { id: order.confirmedByUserId, name: order.confirmedByName } : null,
      confirmationTag: order.confirmedByUserId && order.confirmedByName ? confirmationTagFor(order.confirmedByName) : null,
      shopifyConfirmationTag: ((order.metadata as Record<string, unknown> | null)?.shopifyConfirmationTag as OrderDetail["shopifyConfirmationTag"] | undefined) ?? null,
      // Who created the order (the snapshot stored at creation) and the matching "Order Created by <name>" tag - the same for every viewer, never the viewer's own name.
      createdByUser: creatorOf(order.metadata) ? { id: creatorOf(order.metadata)!.id, name: creatorOf(order.metadata)!.name } : null,
      creatorTag: creatorOf(order.metadata) ? creatorTagFor(creatorOf(order.metadata)!.name) : null,
      shopifyCreatorTag: ((order.metadata as Record<string, unknown> | null)?.shopifyCreatorTag as OrderDetail["shopifyCreatorTag"] | undefined) ?? null,
      shopifySync: ((order.metadata as Record<string, unknown> | null)?.shopifySync as OrderDetail["shopifySync"] | undefined) ?? null,
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
      // Refund APPROVAL workflow state (requests + each payment's eligibility/balance). Display only: nothing here moves money.
      refunds,
      customer: {
        leadId: order.lead.id,
        leadNumber: order.lead.leadNumber,
        name: fullName(order.lead.firstName, order.lead.lastName),
        mobile: order.lead.mobile,
        email: order.lead.email,
        abandonmentId: await this.openableAbandonmentId(user, order.lead.id, order.metadata),
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
        // Weight of one unit as RECORDED in the catalog (variant first, else product); null when nobody recorded one. Informational only.
        unitWeightKg: (item.variant?.weightKg ?? item.product?.weightKg)?.toString() ?? null,
        // Same rule as the weight: the variant's recorded dimensions, else the product's; only when all three sides are recorded.
        unitDimensionsCm: (item.variant ? unitDims(item.variant) : null) ?? (item.product ? unitDims(item.product) : null),
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
        weightKg: shipment.weightKg ? shipment.weightKg.toString() : null,
        linkedShipmentId: shipment.externalSource === "SHOPIFY" && shipment.trackingNumber ? (directByAwb.get(normalizeAwb(shipment.trackingNumber)) ?? null) : null,
        liveTracking: shipment.trackingNumber ? liveTrackingByAwb.get(shipment.trackingNumber) : undefined,
      })),
      shopifyLive: shopifyLiveResult.order,
      shopifyLiveError: shopifyLiveResult.error,
    };
  }

  // E7.8 (WhatsApp -> CRM Order): the CRM's one and only manual order-entry path - used by the
  // WhatsApp Inbox's "Create Order" action, but not specific to it; any caller with a lead in scope
  // can use it. Writes the exact same Order/OrderItem/Payment rows every other order path
  // (Shopify sync) writes, so it appears through listOrders/getOrder/Customer 360 automatically -
  // there is no separate WhatsApp-only order record. source: SALESPERSON marks it as staff-entered,
  // the same value a human-created order already used before this method existed.
  // Duplicate protection for a retried / double-submitted order request. The truth is the database: an `idempotency_keys` row
  // (unique per actor + operation + client key) is written in the SAME transaction that creates the order, so two simultaneous
  // requests - in this process, another process or another server - can never both create one; the loser reads the winner's order.
  // Surviving a restart or a client retry after a timeout is the same mechanism (the row is durable). The per-process map below is
  // only an optimisation: it lets a same-process double click wait for its twin instead of racing it to the unique index.
  private static readonly inFlight = new Map<string, Promise<CreateManualOrderResult>>();

  async createManualOrder(user: AuthUser, input: CreateManualOrderInput): Promise<CreateManualOrderResult> {
    if (!input.idempotencyKey) return this.createManualOrderOnce(user, input);

    const mapKey = `${user.id}:${input.idempotencyKey}`;
    const running = OrdersService.inFlight.get(mapKey);
    if (running) return running.then(() => this.createWithKey(user, input), () => this.createWithKey(user, input));
    const promise = this.createWithKey(user, input);
    OrdersService.inFlight.set(mapKey, promise);
    const clear = () => {
      if (OrdersService.inFlight.get(mapKey) === promise) OrdersService.inFlight.delete(mapKey);
    };
    promise.then(clear, clear);
    return promise;
  }

  private idempotencyWhere(userId: string, key: string) {
    return { userId_operation_key: { userId, operation: ORDER_CREATE_OPERATION, key } };
  }

  private async createWithKey(user: AuthUser, input: CreateManualOrderInput): Promise<CreateManualOrderResult> {
    const key = input.idempotencyKey!;
    const hash = hashOrderRequest(input);
    const existing = await this.db.idempotencyKey.findUnique({ where: this.idempotencyWhere(user.id, key) });
    if (existing) return this.replayOrder(user, input, existing, hash);
    try {
      const result = await this.createManualOrderOnce(user, input, { key, hash });
      await this.completeIdempotency(user.id, key, result);
      return result;
    } catch (error) {
      if (!(error instanceof IdempotencyRaceLost)) throw error; // anything else: nothing was committed under this key, so the same key can simply be retried
      const winner = await this.db.idempotencyKey.findUnique({ where: this.idempotencyWhere(user.id, key) });
      if (!winner) throw error;
      return this.replayOrder(user, input, winner, hash);
    }
  }

  private async completeIdempotency(userId: string, key: string, result: CreateManualOrderResult): Promise<void> {
    const stored = JSON.parse(JSON.stringify({ shopify: result.shopify, paymentLink: result.paymentLink, whatsapp: result.whatsapp }));
    await this.db.idempotencyKey.updateMany({ where: { userId, operation: ORDER_CREATE_OPERATION, key, status: { not: IDEMPOTENCY_COMPLETED } }, data: { status: IDEMPOTENCY_COMPLETED, result: stored } });
  }

  // A repeat of a request that already created an order. Same key + different request is refused; a finished request is answered with the
  // ORIGINAL order; one still running elsewhere is waited for; one that was interrupted (crash, timeout, lost Shopify answer) is reconciled -
  // never repeated - so no second CRM order, Shopify order or notification can result.
  private async replayOrder(user: AuthUser, input: CreateManualOrderInput, row: { requestHash: string; orderId: string | null; status: string; result: unknown }, hash: string): Promise<CreateManualOrderResult> {
    if (row.requestHash !== hash) {
      throw new ApiError("This idempotency key was already used for a different order request. Resend the original request, or use a new key for a new order.", 422);
    }
    if (!row.orderId) throw new ApiError("The original request has no order to return", STATUS_CODES.CONFLICT);
    const key = input.idempotencyKey!;
    let current = row;
    const deadline = Date.now() + idempotencyTuning.replayWaitMs;
    while (current.status !== IDEMPOTENCY_COMPLETED && Date.now() < deadline) {
      await sleep(idempotencyTuning.pollMs);
      const fresh = await this.db.idempotencyKey.findUnique({ where: this.idempotencyWhere(user.id, key) });
      if (fresh) current = fresh;
    }
    if (current.status !== IDEMPOTENCY_COMPLETED) {
      await this.finishInterrupted(user, input, current.orderId!);
      const fresh = await this.db.idempotencyKey.findUnique({ where: this.idempotencyWhere(user.id, key) });
      if (fresh) current = fresh;
    }
    const order = await this.getOrder(user, current.orderId!); // scoped: a user who cannot see this order never gets it
    const stored = (current.result && typeof current.result === "object" ? current.result : {}) as { shopify?: ShopifyPushResult; paymentLink?: OrderPaymentLinkResult | null; whatsapp?: OrderNotifyResult };
    // The original answer said the Shopify step FAILED (possibly an ambiguous one: a timeout after Shopify had created the order). Retrying the same request
    // reconciles that step - through the claim and the lookup by source identifier, never a blind second create - and remembers the outcome.
    if (stored.shopify?.status === "failed") {
      const unlinked = await this.db.order.findUnique({ where: { id: order.id }, select: { externalId: true } });
      if (!unlinked?.externalId) {
        stored.shopify = await this.pushOrderToShopify(user, order.id);
        await this.db.idempotencyKey.updateMany({ where: { userId: user.id, operation: ORDER_CREATE_OPERATION, key }, data: { result: JSON.parse(JSON.stringify(stored)) } });
      }
    }
    const linked = await this.db.order.findUnique({ where: { id: order.id }, select: { externalId: true, externalNumber: true } });
    const shopify: ShopifyPushResult =
      linked?.externalId && stored.shopify?.status !== "created"
        ? { status: "already_linked", shopifyOrderId: linked.externalId, shopifyOrderName: linked.externalNumber ?? undefined }
        : (stored.shopify ?? { status: "failed", reason: "Shopify status unknown for this request" });
    return { order, shopify, paymentLink: stored.paymentLink ?? null, whatsapp: stored.whatsapp ?? { sent: false, via: null, provider: null, reason: "Nothing to notify for this payment method." } };
  }

  // The original request committed the order but never finished its follow-ups (process crash, client timeout, lost Shopify answer).
  // Finish them ONCE, idempotently: the Shopify link goes through the claim + lookup-by-source-identifier path (never a blind second
  // create), a prepaid order's payment link is the existing reuse-or-create, and notifications are NOT resent (they may already have gone).
  private async finishInterrupted(user: AuthUser, input: CreateManualOrderInput, orderId: string): Promise<void> {
    const shopify: ShopifyPushResult = input.paymentMethod === "COD" ? await this.pushOrderToShopify(user, orderId) : { status: "awaiting_payment", reason: "Prepaid: the Shopify order is created after Cashfree confirms the payment." };
    let paymentLink: OrderPaymentLinkResult | null = null;
    if (input.paymentMethod === "PAYMENT_LINK") {
      try {
        const link = await this.getCashfree().createPaymentLink(user, orderId);
        paymentLink = { status: link.reused ? "reused" : "created", paymentId: link.paymentId, paymentUrl: link.paymentUrl, expiresAt: link.expiresAt };
      } catch (error) {
        paymentLink = { status: "failed", reason: error instanceof Error ? error.message : "Could not create a Cashfree payment link" };
      }
    }
    const result = { shopify, paymentLink, whatsapp: { sent: false, via: null, provider: null, reason: "Completed on a retry: the original request was interrupted, so notifications were not repeated." } } as CreateManualOrderResult;
    await this.completeIdempotency(user.id, input.idempotencyKey!, result);
  }

  private async createManualOrderOnce(user: AuthUser, input: CreateManualOrderInput, idem?: { key: string; hash: string }): Promise<CreateManualOrderResult> {
    const leadScope = await getOrderFlowScope(user, this.db);
    const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(input.leadId, leadScope), select: { id: true, normalizedMobile: true } });
    // Out-of-scope reads the same as missing, same convention as every other single-lead lookup.
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);
    // An order created from an abandoned checkout: that checkout must be THIS customer's (never another lead's cart), or the request is refused.
    let abandonmentRef: { id: string; referenceId: string | null } | null = null;
    if (input.abandonmentId) {
      const checkout = await this.db.abandonment.findFirst({ where: { id: input.abandonmentId, leadId: lead.id }, select: { id: true, referenceId: true } });
      if (!checkout) throw new ApiError("Abandoned checkout not found for this customer", STATUS_CODES.NOT_FOUND);
      abandonmentRef = checkout;
    }

    // "Send via WhatsApp": number, consent and template are validated BEFORE anything is created, so a telecaller who can fix it is told
    // at once and no order is left half-done. (A send that fails AFTER the order exists is handled below and never undoes it.)
    const whatsappSend = input.sendPaymentLinkViaWhatsApp === true ? await validateWhatsAppPaymentSend(this.db, lead, input) : null;

    const productIds = [...new Set(input.items.map((i) => i.productId))];
    const products = await this.db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, sku: true, variants: { select: { id: true, name: true, sku: true } } },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    // Lines are read back ordered by createdAt, then id; rows inserted together tie on createdAt and the random id would then shuffle them.
    // A strictly increasing createdAt per line keeps the order the salesperson entered (message, Shopify lines, order page).
    const itemsCreatedAt = Date.now();
    const itemRows = input.items.map((item, index) => {
      const product = productById.get(item.productId);
      if (!product) throw new ApiError(`Product not found: ${item.productId}`, STATUS_CODES.BAD_REQUEST);
      const variant = item.variantId ? product.variants.find((v) => v.id === item.variantId) : undefined;
      if (item.variantId && !variant) throw new ApiError(`Variant not found on this product: ${item.variantId}`, STATUS_CODES.BAD_REQUEST);

      const lineTotalCents = toCents(item.unitPrice) * item.quantity - toCents(item.discountAmount);
      return {
        id: randomUUID(),
        createdAt: new Date(itemsCreatedAt + index),
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
    // Custom Discount (percentage): the backend is authoritative - whatever total the browser showed is ignored, and the
    // total below is what the order row, the Cashfree link (which reads Order.totalAmount) and the WhatsApp message use.
    if (input.discountPercent !== undefined && input.discountAmount !== undefined) {
      throw new ApiError("Send either discountPercent or discountAmount, not both", STATUS_CODES.BAD_REQUEST);
    }
    if (input.discount !== undefined && (input.discountPercent !== undefined || input.discountAmount !== undefined)) {
      throw new ApiError("Send either discount, discountPercent or discountAmount - one discount only", STATUS_CODES.BAD_REQUEST);
    }
    const percentDiscount = input.discountPercent !== undefined ? computePercentDiscount(subtotalCents - itemDiscountCents, input.discountPercent) : null;
    // New selection model: resolved here against the live Fastrr offers and the real subtotal (items after line discounts).
    const resolvedDiscount: ResolvedDiscount | null = input.discount !== undefined ? await new DiscountsService(this.db).resolve("ORDER", input.discount, subtotalCents - itemDiscountCents) : null;
    // Billing rules, decided HERE (the browser's figures are only a preview):
    //  - the configured default discount (Rs 50 unless the business changes it) is a PREPAID promotion: it never applies to a COD order. A discount chosen on purpose
    //    (a Fastrr coupon, or a custom value that is not the default) is not "automatic" and is left exactly as it was;
    //  - shipping is a flat rule (orders.shipping.ts): COD pays exactly INR 50, once per order; a prepaid order is always shipped free. The shippingAmount the request carried
    //    (a courier quote, or a manipulated value) is IGNORED - the order row, the Cashfree/WhatsApp amounts and the Shopify payload all read what is computed here.
    const isCod = input.paymentMethod === "COD";
    const selected: ResolvedDiscount | null = resolvedDiscount && isCod && resolvedDiscount.source === "CUSTOM" && resolvedDiscount.wasDefault ? null : resolvedDiscount;
    const orderDiscountCents = selected ? selected.amountCents : percentDiscount ? percentDiscount.discountCents : toCents(input.discountAmount);
    const shippingCents = shippingChargeCents(isCod);
    const totalCents = Math.max(subtotalCents - itemDiscountCents - orderDiscountCents + shippingCents, 0);
    if (input.expectedTotal !== undefined && toCents(input.expectedTotal) !== totalCents) {
      throw new ApiError("The order total changed. Please review the order again.", STATUS_CODES.CONFLICT);
    }

    // Prepaid via a Cashfree payment link: no Payment row is created here (below) - CashfreePaymentsService.
    // createPaymentLink is the sole creator of that row (see the call after this transaction), so an order
    // never ends up with two rows for what is really one payment attempt.
    const isPaymentLink = input.paymentMethod === "PAYMENT_LINK";
    const now = new Date();
    const orderId = randomUUID();

    // Same "generate, try, retry on the rare collision" idiom as createLeadWithUniqueNumber -
    // orderNumber is @unique, so a clash (astronomically unlikely, but real) must never 500.
    // Who creates this order: read from the authenticated user's own User row (never from the request) and stored on the order, so the "Order Created by <name>" tag and the
    // audit of the creator do not depend on who is logged in later. null (user not found) -> no creator is stored and no creator tag is ever made.
    const creator = await resolveCreatorSnapshot(this.db as never, { id: user.id, role: user.role });
    let createdOrderId: string | null = null;
    for (let attempt = 0; attempt < 5 && !createdOrderId; attempt++) {
      try {
        await this.db.$transaction(async (tx) => {
          // FIRST statement of the transaction: claim the idempotency key. A concurrent request with the same key blocks on the unique index
          // until this transaction commits (then loses with a unique violation) or rolls back (then proceeds): exactly one order per key.
          if (idem) await tx.idempotencyKey.create({ data: { userId: user.id, operation: ORDER_CREATE_OPERATION, key: idem.key, requestHash: idem.hash, orderId, status: IDEMPOTENCY_ORDER_CREATED } });
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
              shippingAmount: fromCents(shippingCents),
              totalAmount: fromCents(totalCents),
              discountReason: input.discountReason ?? (selected && selected.source !== "NONE" ? (selected.couponCode ? `Fastrr coupon ${selected.couponCode}` : "Custom discount") : undefined),
              shippingAddress: input.shippingAddress ?? undefined,
              shippingPincode: input.shippingPincode ?? input.shippingAddress?.pincode,
              ...(input.parcelWeightKg !== undefined ? { parcelWeightKg: input.parcelWeightKg } : {}),
              // Free-form, existing field (Order.metadata) - never a new column. paymentMode mirrors
              // the exact same derived value Shopify-synced orders already carry (shopify.mapper.ts).
              metadata: {
                paymentMode: isCod ? "COD" : "PREPAID",
                createdVia: "WHATSAPP_INBOX",
                ...(abandonmentRef ? { abandonment: { id: abandonmentRef.id, referenceId: abandonmentRef.referenceId } } : {}),
                ...(creator ? { createdBy: creator as unknown as Prisma.InputJsonValue } : {}),
                // The discount that was actually applied and why - kept on the order, so the reason for a reduced total never
                // depends on a coupon row staying the same. originalSubtotal is the pre-discount item total.
                ...(selected ? { discount: { originalSubtotal: fromCents(subtotalCents), discountType: selected.type, discountValue: selected.value, discountAmount: fromCents(itemDiscountCents + selected.amountCents), couponId: selected.couponId, couponCode: selected.couponCode, couponSource: selected.couponSource, source: selected.source, wasDefault: selected.wasDefault, finalTotal: fromCents(totalCents), appliedById: user.id } } : {}),
                ...(percentDiscount && percentDiscount.discountCents > 0 ? { customDiscount: { percent: percentDiscount.percent, amount: fromCents(percentDiscount.discountCents), appliedById: user.id } } : {}),
              },
              placedAt: now,
              confirmedAt: isCod ? now : null,
              items: { createMany: { data: itemRows } },
              ...(isPaymentLink ? {} : { payments: { create: { amount: fromCents(totalCents), currency: "INR", method: input.paymentMethod, status: "PENDING" } } }),
            },
          });
          // The COD order is confirmed right here (status CONFIRMED), by the authenticated telecaller - the name is read from their
          // User row, never from the request.
          if (isCod) await recordConfirmation(tx as never, orderId, { id: user.id, role: user.role }, now);
          // The ticked WhatsApp consent is recorded with the order (an existing OPTED_IN is kept; an OPTED_OUT is never overwritten).
          if (whatsappSend?.recordConsent) await recordWhatsAppConsent(tx as never, lead.id, now);
          await tx.lead.update({ where: { id: lead.id }, data: { lifecycleStage: "CUSTOMER" } });
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
              ...(abandonmentRef ? { description: "Created from an abandoned checkout" } : {}),
            },
          });
        });
        createdOrderId = orderId;
      } catch (error: any) {
        if (error?.code === "P2002" && idem) {
          // A unique violation is either the idempotency key (another request committed it first) or the order number (collision).
          const winner = await this.db.idempotencyKey.findUnique({ where: this.idempotencyWhere(user.id, idem.key) });
          if (winner && winner.orderId !== orderId) throw new IdempotencyRaceLost();
        }
        if (error?.code === "P2002" && attempt < 4) continue; // orderNumber collision - retry with a new one
        throw error;
      }
    }
    if (!createdOrderId) throw new ApiError("Failed to generate a unique order number", STATUS_CODES.SERVER_ERROR);

    // Best-effort, immediately after: the CRM order is already durably committed above regardless of
    // what happens here. A Shopify failure is reported, never hidden, and never rolls back or
    // duplicates the CRM order - retrying just calls pushOrderToShopify again (see there for why
    // that's always safe).
    // PREPAID: the CRM order is only a payment request (PENDING_PAYMENT) until Cashfree verifies the payment; the Shopify order is created then (see orders.prepaid-confirm.ts). COD is pushed at once, as before.
    const shopify: ShopifyPushResult = input.paymentMethod === "COD" ? await this.pushOrderToShopify(user, createdOrderId) : { status: "awaiting_payment", reason: "Prepaid: the Shopify order is created after Cashfree confirms the payment." };
    const order = await this.getOrder(user, createdOrderId);

    // Prepaid: create exactly one Cashfree payment link for this order (best-effort - see
    // CashfreePaymentsService.createPaymentLink for its own idempotency/locking), then send it.
    // COD: send the existing order confirmation. Neither ever rolls back or fails the order above.
    let paymentLink: OrderPaymentLinkResult | null = null;
    let whatsapp: OrderNotifyResult = { sent: false, via: null, provider: null, reason: "Nothing to notify for this payment method." };
    if (isPaymentLink) {
      try {
        const link = await this.getCashfree().createPaymentLink(user, createdOrderId);
        paymentLink = { status: link.reused ? "reused" : "created", paymentId: link.paymentId, paymentUrl: link.paymentUrl, expiresAt: link.expiresAt };
        // `Don't send` (sendPaymentLinkViaWhatsApp === false) skips the message; the link stays on the order for the existing send action.
        if (input.sendPaymentLinkViaWhatsApp === false) {
          whatsapp = { sent: false, via: null, provider: null, reason: "Not sent: WhatsApp sending was not selected. Use Send payment link on the order when ready." };
        } else {
          whatsapp = link.paymentUrl
            ? await this.notify.paymentLink(this.db, user, { leadId: lead.id, orderId: createdOrderId, normalizedMobile: lead.normalizedMobile, orderNumber: order.orderNumber, paymentUrl: link.paymentUrl, amount: link.amount, currency: link.currency, customerName: order.customer.name, items: messageItems(order), ...(whatsappSend?.templateId ? { templateId: whatsappSend.templateId } : {}) })
            : { sent: false, via: null, provider: null, reason: "The payment link has no URL yet." };
          // A requested send that did not go through says so plainly; the order and its payment link are kept for the retry.
          if (whatsappSend && !whatsapp.sent && whatsapp.reason && !whatsapp.reason.startsWith("Payment link not sent")) whatsapp = { ...whatsapp, reason: `Payment link not sent — ${whatsapp.reason}` };
        }
      } catch (error) {
        paymentLink = { status: "failed", reason: error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Could not create a Cashfree payment link" };
        whatsapp = { sent: false, via: null, provider: null, reason: "Payment link unavailable - no link was created, so nothing was sent." };
      }
    } else if (isCod) {
      whatsapp = await this.notify.confirmation(this.db, user, { leadId: lead.id, orderId: createdOrderId, normalizedMobile: lead.normalizedMobile, orderNumber: order.orderNumber, totalAmount: order.totalAmount, currency: order.currency, customerName: order.customer.name, items: messageItems(order) });
    }

    // Remembered on the order so its page still shows what happened after a reload (COD confirmation or payment link).
    if (isPaymentLink || isCod) await recordOrderNotification(this.db, createdOrderId, whatsapp);

    return { order: isPaymentLink || isCod ? await this.getOrder(user, createdOrderId) : order, shopify, paymentLink, whatsapp };
  }

  // What the Create Order screen needs for "Send via WhatsApp": the approved Meta payment templates, the customer's recorded WhatsApp consent
  // and whether they have a number. Lead-scoped like every other single-lead lookup; no provider ids or secrets are returned.
  async getWhatsAppPaymentOptions(user: AuthUser, leadId: string): Promise<WhatsAppPaymentOptions> {
    const leadScope = await getOrderFlowScope(user, this.db);
    const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(leadId, leadScope), select: { id: true, normalizedMobile: true } });
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);
    return getWhatsAppPaymentOptions(this.db, lead);
  }

  // Prefill for the Create Order form. The shared resolver (orders.address-resolver.ts) reads the SELECTED customer's latest order address - CRM or Shopify-synced, any stored field
  // naming - then the address they typed at checkout, then another lead record of the same person; never a different customer who merely shares the phone number. Read-only and
  // lead-scoped like every other single-lead lookup (out of scope reads as "not found").
  async getLastShippingAddress(user: AuthUser, leadId: string): Promise<{ address: ResolvedAddress | null; source: AddressSource | null }> {
    const leadScope = await getOrderFlowScope(user, this.db);
    const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(leadId, leadScope), select: { id: true } });
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);
    const { address, source } = await resolveAddressForLead(this.db, lead.id);
    return { address, source };
  }

  // Pushes an already-created CRM order to Shopify via the Admin GraphQL orderCreate mutation - the
  // one and only Shopify write in this codebase (shopify.sync.ts/shopify.orders.ts stay read-only).
  // Idempotent by construction: once externalId is set, this only ever returns "already_linked" and
  // never calls Shopify again - the safe way to let a caller "retry" after a failure without ever
  // creating a second Shopify order for the same CRM order.
  async pushOrderToShopify(user: AuthUser | null, orderId: string): Promise<ShopifyPushResult> {
    const result = await this.linkOrderToShopify(user, orderId);
    // Once the order is linked to Shopify, its "CRM Confirmed by <name>" tag is brought in line (best-effort, idempotent). This is
    // also what delivers the tag for an order that was confirmed BEFORE it was linked, whenever the link finally succeeds.
    if (result.status === "created" || result.status === "already_linked") {
      await this.syncConfirmationTagSafely(orderId);
      await this.syncCreatorTagSafely(orderId);
      // A prepaid order whose payment was ALREADY verified before it reached Shopify (the normal prepaid lifecycle, or a manual retry of a failed push) is marked paid now - and only then.
      if (result.status === "created") {
        await this.settlePaidPrepaidOnShopify(orderId);
        // The Orders page is a cached live Shopify list: without this a just-created order stays hidden from an already-cached page for up to the cache TTL.
        clearLiveOrderCaches();
      }
    }
    return result;
  }

  /** Marks the just-created Shopify order paid, but only when the CRM holds a SUCCESSFUL (verified) payment for it. Idempotent (syncShopifyPayment is guarded). Never throws. */
  private async settlePaidPrepaidOnShopify(orderId: string): Promise<void> {
    try {
      const o = await this.db.order.findUnique({ where: { id: orderId }, select: { metadata: true, payments: { select: { status: true } } } });
      const prepaid = (o?.metadata as Record<string, unknown> | null)?.paymentMode === "PREPAID";
      if (!o || !prepaid || !o.payments.some((p) => p.status === "SUCCESS")) return;
      await syncShopifyPayment(this.db as never, orderId, { source: ActivitySource.SYSTEM, getShopifyClient: this.getShopifyClient });
    } catch (error) {
      logger.warn(`Shopify payment settle failed for order ${orderId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Same contract as syncConfirmationTagSafely: never throws, never undoes the order; a Shopify failure is remembered on the order (Order.metadata.shopifyCreatorTag) for a retry.
  private async syncCreatorTagSafely(orderId: string): Promise<CreatorTagSyncResult> {
    try {
      return await syncCreatorTag(this.db as never, orderId, { getShopifyClient: this.getShopifyClient });
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : "Shopify creator tag sync failed" };
    }
  }

  // Never throws and never touches the confirmation itself: a Shopify failure is remembered on the order (see syncConfirmationTag)
  // and shown there, so it can be retried.
  private async syncConfirmationTagSafely(orderId: string): Promise<ConfirmationTagSyncResult> {
    try {
      return await syncConfirmationTag(this.db as never, orderId, { getShopifyClient: this.getShopifyClient });
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : "Shopify tag sync failed" };
    }
  }

  // Manual "Retry Shopify tag sync" for the order page. Re-checks Shopify even when the CRM believes the tag is in place.
  async retryConfirmationTagSync(user: AuthUser, orderId: string): Promise<ConfirmationTagSyncResult & { creator?: CreatorTagSyncResult }> {
    const leadScope = await getLeadScope(user, this.db);
    const order = await this.db.order.findFirst({ where: scopedOrderWhere(orderId, leadScope), select: { id: true } });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    let confirmation: ConfirmationTagSyncResult;
    try {
      confirmation = await syncConfirmationTag(this.db as never, orderId, { getShopifyClient: this.getShopifyClient, force: true });
    } catch (error) {
      confirmation = { status: "failed", reason: error instanceof Error ? error.message : "Shopify tag sync failed" };
    }
    // The same retry also re-syncs the creator tag (add-only, only if it is missing on Shopify), so one safe button repairs both tags.
    let creatorResult: CreatorTagSyncResult;
    try {
      creatorResult = await syncCreatorTag(this.db as never, orderId, { getShopifyClient: this.getShopifyClient, force: true });
    } catch (error) {
      creatorResult = { status: "failed", reason: error instanceof Error ? error.message : "Shopify creator tag sync failed" };
    }
    const failed = confirmation.status === "failed" || creatorResult.status === "failed";
    return { ...confirmation, ...(failed ? { status: "failed" as const, reason: confirmation.reason ?? creatorResult.reason } : {}), creator: creatorResult };
  }

  // Only ONE caller at a time may create the Shopify order for a CRM order (two concurrent retries could otherwise each create one before either links it).
  // The claim is a conditional UPDATE on the order row, so it holds across processes; a claim older than the lease belongs to a dead process and is taken over.
  private async linkOrderToShopify(user: AuthUser | null, orderId: string): Promise<ShopifyPushResult> {
    const leadScope = user ? await getOrderFlowScope(user, this.db) : {}; // null = the system finishing a verified payment (no user in a webhook)
    const visible = await this.db.order.findFirst({ where: scopedOrderWhere(orderId, leadScope), select: { id: true, externalId: true, externalNumber: true } });
    if (!visible) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    if (visible.externalId) return { status: "already_linked", shopifyOrderId: visible.externalId, shopifyOrderName: visible.externalNumber ?? undefined };
    const deadline = Date.now() + idempotencyTuning.waitMs;
    for (;;) {
      // Taking over an EXPIRED claim (its holder died, or hung) also marks the order "uncertain": the previous holder may have got as far as creating the Shopify
      // order, so the order is looked up by its source identifier before anything is created.
      const claimed = await this.db.$executeRaw`UPDATE orders SET metadata = CASE WHEN metadata->>'shopifyPushClaimedAt' IS NOT NULL THEN jsonb_set(jsonb_set(COALESCE(metadata, '{}'::jsonb), '{shopifyPushClaimedAt}', to_jsonb(now()::text)), '{shopifyCreateUncertain}', 'true'::jsonb) ELSE jsonb_set(COALESCE(metadata, '{}'::jsonb), '{shopifyPushClaimedAt}', to_jsonb(now()::text)) END WHERE id = ${orderId}::uuid AND external_id IS NULL AND (metadata->>'shopifyPushClaimedAt' IS NULL OR (metadata->>'shopifyPushClaimedAt')::timestamptz < now() - make_interval(secs => ${idempotencyTuning.leaseSeconds}))`;
      if (claimed > 0) break;
      const now = await this.db.order.findUnique({ where: { id: orderId }, select: { externalId: true, externalNumber: true } });
      if (now?.externalId) return { status: "already_linked", shopifyOrderId: now.externalId, shopifyOrderName: now.externalNumber ?? undefined };
      if (Date.now() >= deadline) return { status: "failed", reason: "A Shopify sync for this order is already running. Try again in a moment." };
      await sleep(idempotencyTuning.pollMs);
    }
    try {
      return await this.linkOrderToShopifyClaimed(user, orderId);
    } finally {
      await this.db.$executeRaw`UPDATE orders SET metadata = metadata - 'shopifyPushClaimedAt' WHERE id = ${orderId}::uuid AND metadata ? 'shopifyPushClaimedAt'`;
    }
  }

  private async linkOrderToShopifyClaimed(user: AuthUser | null, orderId: string): Promise<ShopifyPushResult> {
    const leadScope = user ? await getOrderFlowScope(user, this.db) : {};
    const order = await this.db.order.findFirst({
      where: scopedOrderWhere(orderId, leadScope),
      select: SHOPIFY_PUSH_SELECT,
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

    const prepared = await prepareShopifyPayload(order, client);
    const { built, customerDecision, extras, crmFiguresAddUp } = prepared;
    const input: ShopifyOrderCreateInput = built.input;

    try {
      let result: Awaited<ReturnType<typeof createShopifyOrder>>;
      let mirrored = crmFiguresAddUp;
      const sentOmitted: string[] = Object.entries(built.report.fields).filter(([, f]) => f.outcome === "omitted").map(([k, f]) => `${k}: ${f.reason}`);
      let verifiedSync: ShopifySyncRecord | null = null;
      // A fallback that dropped information the CRM HAS (customer / discount) or a customer that could not be attached is never a complete sync.
      let degraded: string[] = customerDecision.customer ? [] : (customerDecision.note.startsWith("the lead has no phone") ? [] : [`customer not associated: ${customerDecision.note}`]);
      const earlier = (order.metadata as Record<string, unknown> | null)?.shopifyCreateUncertain === true;
      // A previous attempt ended without an answer (timeout / dropped connection): Shopify may well have created the order. Look for it by the CRM order number FIRST; creating blindly could make a second one.
      const existing = earlier ? await findShopifyOrderBySourceIdentifier(client, order.orderNumber) : null;
      if (existing) {
        result = existing;
        mirrored = false; // what that attempt sent is not known here, so the payment sync keeps its safe reconciliation
      } else {
        try {
          result = await createShopifyOrder(client, input);
        } catch (error) {
          if (!isShopifyRejection(error)) throw error;
          // Shopify REFUSED the request (nothing was created). Retry once, dropping the optional parts that most often cause a refusal, and say so in the sync result:
          // the customer association (a phone/e-mail that belongs to another Shopify customer) and the discount/shipping mirror.
          const rejection = error instanceof Error ? error.message : "rejected";
          if (!input.customer && !extras) throw error;
          if (input.customer) { sentOmitted.push(`customer (Shopify refused it: ${rejection.slice(0, 120)})`); degraded.push("customer: Shopify refused the association"); }
          if (extras) { mirrored = false; sentOmitted.push("discount/shipping mirror (Shopify refused it)"); degraded.push("discount/shipping were not mirrored"); }
          input.customer = undefined;
          if (extras) { input.discount = undefined; input.shippingAmount = undefined; }
          result = await createShopifyOrder(client, input);
        }
      }
      // Read the order BACK and compare it with what was sent: a 200 with no userErrors does not prove every field was saved. A missing shipping address / metafields is re-sent once with orderUpdate (those
      // fields only); anything still missing is recorded as a PARTIAL sync - never reported as complete.
      {
        const attemptAt = new Date().toISOString();
        try {
          let check = await verifyShopifyOrder(client, result.shopifyOrderId, input, mirrored ? order.totalAmount.toString() : undefined);
          const repaired: string[] = [];
          if (check.missing.length > 0) {
            const fix = await repairShopifyOrderFields(client, result.shopifyOrderId, input, check.missing);
            repaired.push(...fix.attempted);
            if (fix.attempted.length > 0) check = await verifyShopifyOrder(client, result.shopifyOrderId, input, mirrored ? order.totalAmount.toString() : undefined);
          }
          verifiedSync = { status: check.missing.length === 0 && degraded.length === 0 ? "complete" : "partial", missing: [...check.missing, ...degraded], omitted: sentOmitted, repaired, customer: check.customerAssociated ? customerDecision.note : `no Shopify customer record: ${customerDecision.note}`, attemptedAt: attemptAt, verifiedAt: check.missing.length === 0 ? new Date().toISOString() : null, retryAdvice: syncAdvice(check.missing, degraded), error: null };
        } catch (verifyError) {
          verifiedSync = { status: "partial", missing: ["(could not read the order back to verify it)", ...degraded], omitted: sentOmitted, repaired: [], customer: customerDecision.note, attemptedAt: attemptAt, verifiedAt: null, retryAdvice: "RETRY", error: sanitizeSyncError(verifyError) };
          logger.error("Shopify order read-back failed", sanitizeSyncError(verifyError));
        }
      }
      // Guarded by the same id + "still unlinked" condition just checked above, so two concurrent
      // pushes can never both win and create two Shopify orders for this one CRM order.
      const { count } = await this.db.order.updateMany({
        where: { id: orderId, externalId: null },
        // The canonical numeric id (what every Shopify-synced order holds), not the GID orderCreate returns - so the live views and the sync find this row.
        data: { externalSource: "SHOPIFY", externalId: normalizeShopifyOrderId(result.shopifyOrderId), externalNumber: result.shopifyOrderName, externalUpdatedAt: new Date() },
      });
      if (count === 0) {
        // Lost a race to a concurrent push that already linked it - report that one, not a phantom second order.
        const linked = await this.db.order.findUniqueOrThrow({ where: { id: orderId }, select: { externalId: true, externalNumber: true } });
        return { status: "already_linked", shopifyOrderId: linked.externalId!, shopifyOrderName: linked.externalNumber ?? undefined };
      }
      // Remember what Shopify was given: mirrored = the Shopify order total equals the CRM total (see above). The payment sync relies on it; absent/false (older orders, a refused request) keeps the safe path.
      const fresh = await this.db.order.findUnique({ where: { id: orderId }, select: { metadata: true } });
      await this.db.order.update({ where: { id: orderId }, data: { metadata: { ...((fresh?.metadata as Record<string, unknown> | null) ?? {}), shopifyTotals: { mirrored, total: order.totalAmount.toString(), at: new Date().toISOString() }, ...(verifiedSync ? { shopifySync: verifiedSync } : {}) } as unknown as Prisma.InputJsonValue } });
      return { status: "created", shopifyOrderId: result.shopifyOrderId, shopifyOrderName: result.shopifyOrderName, ...(verifiedSync ? { sync: verifiedSync } : {}) };
    } catch (error) {
      if (error instanceof ShopifyOrderCreateError) return { status: "failed", reason: error.message };
      if (error instanceof ShopifyApiError) {
        // No answer (timeout / unreachable / throttled): the CRM order stays committed, the failure is reported, and the next retry checks Shopify for the order before creating one.
        const fresh = await this.db.order.findUnique({ where: { id: orderId }, select: { metadata: true } });
        await this.db.order.update({ where: { id: orderId }, data: { metadata: { ...((fresh?.metadata as Record<string, unknown> | null) ?? {}), shopifyCreateUncertain: true } } });
        return { status: "failed", reason: `${error.message}. Shopify may have received the order; Retry will look for it before creating another.` };
      }
      throw error;
    }
  }

  /**
   * Re-verify (and, where Shopify allows, repair) an order that is ALREADY linked to Shopify - used after a partial sync. It never creates an order, never touches payment, fulfilment, totals, items or the note,
   * and repairs only the shipping address, the crm.* metafields and missing tags (add-only). Idempotent: nothing is written when nothing is missing. Admin / manager only (route), within order scope.
   */
  async resyncShopifyOrder(user: AuthUser, orderId: string): Promise<ShopifyPushResult> {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    const leadScope = await getOrderFlowScope(user, this.db);
    const order = await this.db.order.findFirst({ where: scopedOrderWhere(orderId, leadScope), select: SHOPIFY_PUSH_SELECT });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    if (!order.externalId) return { status: "failed", reason: "This order is not linked to Shopify yet - use Push to Shopify first." };
    let client: ShopifyClient;
    try {
      client = this.getShopifyClient();
    } catch (error) {
      if (error instanceof ShopifyConfigError) return { status: "failed", reason: error.message };
      throw error;
    }
    const attemptAt = new Date().toISOString();
    const prepared = await prepareShopifyPayload(order, client);
    const input = prepared.built.input;
    const mirroredMeta = (order.metadata as Record<string, any> | null)?.shopifyTotals?.mirrored === true;
    const expectedTotal = mirroredMeta ? order.totalAmount.toString() : undefined;
    let record: ShopifySyncRecord;
    try {
      let check = await verifyShopifyOrder(client, order.externalId, input, expectedTotal);
      const repaired: string[] = [];
      if (check.missing.length > 0) {
        const fix = await repairShopifyOrderFields(client, order.externalId, input, check.missing);
        repaired.push(...fix.attempted);
        if (check.missing.includes("tags") && input.tags?.length) {
          await addShopifyOrderTags(client, order.externalId, input.tags); // add-only: existing tags are kept
          repaired.push("tags");
        }
        if (repaired.length > 0) check = await verifyShopifyOrder(client, order.externalId, input, expectedTotal);
      }
      const degraded = prepared.customerDecision.customer || check.customerAssociated ? [] : [`customer not associated: ${prepared.customerDecision.note}`];
      const omitted = Object.entries(prepared.built.report.fields).filter(([, f]) => f.outcome === "omitted").map(([k, f]) => `${k}: ${f.reason}`);
      record = { status: check.missing.length === 0 && degraded.length === 0 ? "complete" : "partial", missing: [...check.missing, ...degraded], omitted, repaired, customer: check.customerAssociated ? "a Shopify customer is attached" : `no Shopify customer record: ${prepared.customerDecision.note}`, attemptedAt: attemptAt, verifiedAt: check.missing.length === 0 ? new Date().toISOString() : null, retryAdvice: syncAdvice(check.missing, degraded), error: null };
    } catch (error) {
      record = { status: "failed", missing: [], omitted: [], repaired: [], customer: "", attemptedAt: attemptAt, verifiedAt: null, retryAdvice: "RETRY", error: sanitizeSyncError(error) };
    }
    const fresh = await this.db.order.findUnique({ where: { id: orderId }, select: { metadata: true } });
    await this.db.order.update({ where: { id: orderId }, data: { metadata: { ...((fresh?.metadata as Record<string, unknown> | null) ?? {}), shopifySync: record } as unknown as Prisma.InputJsonValue } });
    return { status: record.status === "failed" ? "failed" : "already_linked", shopifyOrderId: order.externalId, shopifyOrderName: order.externalNumber ?? undefined, reason: record.error ?? undefined, sync: record };
  }

  // Manual "Retry Shopify payment sync" action for the order page - the same idempotent reconciliation the Cashfree
  // webhook already triggers automatically on a successful payment, callable again if that first attempt failed
  // (Shopify was briefly down, the order was not yet linked, etc). Same lead-scope RBAC as every other single-order
  // action here; syncShopifyPayment itself is the single choke point, so this can never diverge from what the
  // webhook does or double-sync.
  async retryShopifyPaymentSync(user: AuthUser, orderId: string): Promise<ShopifyPaymentSyncResult> {
    const leadScope = await getLeadScope(user, this.db);
    const order = await this.db.order.findFirst({ where: scopedOrderWhere(orderId, leadScope), select: { id: true } });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    return syncShopifyPayment(this.db, orderId, { source: ActivitySource.USER, actor: { id: user.id, role: user.role } });
  }

  // Cancel/Revert (accidental order protection). Never deletes the order, its items, payments, or
  // Shopify/Cashfree identifiers - only Order.status/cancelledAt/cancelReason change, plus best-effort
  // attempts to (a) cancel the linked Shopify order and (b) cancel any still-UNPAID Cashfree payment
  // link, so a customer can never pay for an order the CRM has cancelled.
  //
  // Idempotent: a second call on an already cancelled order does not re-run the CRM-side transition or
  // write a second Activity. It retries ONLY what is still outstanding: a Shopify cancel that failed
  // (tracked in the existing Order.metadata JSON, no schema change), and/or a Cashfree link that is
  // still open (derived from the Payment row itself - a link cancelled through Cashfree becomes
  // FAILED "Payment link cancelled", so "still PENDING on a cancelled order" IS the retry signal).
  //
  // A payment that already SUCCEEDED is never touched here: no refund is issued, its status is not
  // changed, and no link cancellation is attempted for it (refund tracking only ever happens when a
  // real refund is actually performed - see cashfree.apply.ts).
  private static readonly retryingCancellations = new Set<string>();

  async cancelOrder(user: AuthUser, orderId: string, input: CancelOrderInput, opts: { approverScope?: boolean } = {}): Promise<CancelOrderResult> {
    // approverScope: the refund approval (manager/admin only, decided in RefundsService.approve) cancels the order whichever team it belongs to.
    const leadScope = opts.approverScope ? {} : await getLeadScope(user, this.db);
    const order = await this.db.order.findFirst({
      where: scopedOrderWhere(orderId, leadScope),
      select: { id: true, leadId: true, status: true, externalId: true, metadata: true, payments: { select: { id: true, status: true, externalSource: true, failureReason: true } } },
    });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);

    const meta = (order.metadata as Record<string, unknown> | null) ?? {};
    const priorCancellation = meta.shopifyCancellation as { status: ShopifyCancelResult["status"]; reason?: string } | undefined;
    const priorLinkCancellation = meta.paymentLinkCancellation as { status: PaymentLinkCancelResult["status"]; reason?: string } | undefined;
    const alreadyCancelled = order.status === "CANCELLED";
    const openLinks = order.payments.filter(isOpenCashfreeLink);
    const priorShopify: ShopifyCancelResult = priorCancellation ?? { status: order.externalId ? "failed" : "not_linked", reason: order.externalId ? "Shopify cancellation was not recorded for this order (cancelled before this feature existed)." : undefined };

    // Nothing left to do: already cancelled, Shopify not in a failed state, and no Cashfree link still open.
    if (alreadyCancelled && priorCancellation?.status !== "failed" && openLinks.length === 0) {
      return { order: await this.getOrder(user, orderId, opts), shopify: priorShopify, paymentLink: summarizePaymentLink(order.payments, priorLinkCancellation), alreadyCancelled: true };
    }

    // A retry (the order is already cancelled) is not protected by the conditional status write below, so two
    // concurrent retries are collapsed here (per process, same trade-off as the create-order idempotency map).
    if (alreadyCancelled) {
      if (OrdersService.retryingCancellations.has(orderId)) {
        return {
          order: await this.getOrder(user, orderId, opts),
          shopify: priorShopify,
          paymentLink: openLinks.length ? { status: "failed", reason: "Another cancellation of this order is already in progress." } : summarizePaymentLink(order.payments, priorLinkCancellation),
          alreadyCancelled: true,
        };
      }
      OrdersService.retryingCancellations.add(orderId);
    }

    try {
      const now = new Date();
      // The transition itself is a conditional write, so two concurrent cancels (a double click) can never both "win":
      // only the call that actually flips the status records the Activity and attempts Shopify / Cashfree.
      let cancelledNow = false;
      if (!alreadyCancelled) {
        const { count } = await this.db.order.updateMany({ where: { id: orderId, status: { not: "CANCELLED" } }, data: { status: "CANCELLED", cancelledAt: now, cancelReason: input.reason ?? null } });
        cancelledNow = count > 0;
        if (cancelledNow) {
          // Remembered so revertCancellation() can restore exactly this state instead of guessing one.
          await this.db.order.update({ where: { id: orderId }, data: { metadata: { ...meta, preCancelStatus: order.status } as Prisma.InputJsonValue } });
          meta.preCancelStatus = order.status;
          clearLiveOrderCaches();
        }
        if (!cancelledNow) {
          // Lost the race to a concurrent cancel that is already handling Shopify, Cashfree and the audit event.
          return {
            order: await this.getOrder(user, orderId, opts),
            shopify: { status: order.externalId ? "failed" : "not_linked", reason: order.externalId ? "Another cancellation of this order is already in progress." : undefined },
            paymentLink: openLinks.length ? { status: "failed", reason: "Another cancellation of this order is already in progress." } : { status: "none" },
            alreadyCancelled: true,
          };
        }
      }

      // Shopify: on the first cancel, or when its previous attempt failed. Never re-called otherwise (e.g. when only Cashfree is being retried).
      let shopify: ShopifyCancelResult = priorShopify;
      if ((cancelledNow && priorCancellation?.status !== "cancelled") || priorCancellation?.status === "failed") {
        if (!order.externalId) {
          shopify = { status: "not_linked" };
        } else {
          try {
            const client = this.getShopifyClient();
            await cancelShopifyOrder(client, order.externalId);
            shopify = { status: "cancelled" };
          } catch (error) {
            const reason = error instanceof ShopifyConfigError || error instanceof ShopifyOrderCancelError || error instanceof Error ? error.message : "Could not cancel the Shopify order";
            shopify = { status: "failed", reason };
          }
        }
      }

      // Cashfree: cancel every link that is still UNPAID. A SUCCESS payment has no open link, so it is never in this list.
      let paymentLink: PaymentLinkCancelResult = summarizePaymentLink(order.payments, priorLinkCancellation);
      if (openLinks.length > 0) {
        const failures: string[] = [];
        for (const link of openLinks) {
          try {
            await this.getCashfree().cancelPaymentLink(user, link.id);
          } catch (error) {
            failures.push(error instanceof Error ? error.message : "Could not cancel the Cashfree payment link");
          }
        }
        if (failures.length === 0) {
          paymentLink = { status: "cancelled" };
        } else {
          // The link may have been paid in the meantime (cancelPaymentLink refreshes its status when Cashfree refuses):
          // if so this is a paid order, not a failed cancellation.
          const fresh = await this.db.payment.findMany({ where: { orderId }, select: { id: true, status: true, externalSource: true, failureReason: true } });
          paymentLink = fresh.some((p) => p.status === "SUCCESS") && !fresh.some(isOpenCashfreeLink) ? { status: "paid" } : { status: "failed", reason: failures[0] };
        }
      }

      await this.db.order.update({
        where: { id: orderId },
        data: {
          metadata: {
            ...meta,
            shopifyCancellation: { status: shopify.status, reason: shopify.reason, attemptedAt: now.toISOString() },
            ...(openLinks.length > 0 ? { paymentLinkCancellation: { status: paymentLink.status, reason: paymentLink.reason, attemptedAt: now.toISOString() } } : {}),
          } as Prisma.InputJsonValue,
        },
      });

      if (cancelledNow) {
        await this.db.activity.create({
          data: {
            leadId: order.leadId,
            orderId,
            actorId: user.id,
            actorRole: user.role,
            type: ActivityType.ORDER_CANCELLED,
            referenceType: ORDER_REFERENCE_TYPE,
            referenceId: orderId,
            source: ActivitySource.USER,
            title: "Order cancelled",
            description: input.reason ?? null,
          },
        });
      }

      return { order: await this.getOrder(user, orderId, opts), shopify, paymentLink, alreadyCancelled };
    } finally {
      if (alreadyCancelled) OrdersService.retryingCancellations.delete(orderId);
    }
  }

  // Undoes a CRM cancellation by restoring the status recorded when it was cancelled (metadata.preCancelStatus) -
  // never a guessed one. Only the order's own cancellation fields change: payments, shipments, amounts, items and
  // the customer are not touched. Shopify (and any Cashfree link) cancelled at cancel time stay cancelled - neither
  // can be undone from here - which shopifyCancellation in metadata keeps recording truthfully.
  async revertCancellation(user: AuthUser, orderId: string): Promise<RevertCancellationResult> {
    const leadScope = await getLeadScope(user, this.db);
    const order = await this.db.order.findFirst({ where: scopedOrderWhere(orderId, leadScope), select: { id: true, leadId: true, status: true, metadata: true } });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    if (order.status !== "CANCELLED") {
      return { order: await this.getOrder(user, orderId), restoredStatus: order.status, alreadyActive: true };
    }
    // A refund approved for this order is waiting for / going through execution on the premise that the order is cancelled: reactivating it would contradict that.
    const approvedRefund = await this.db.refundRequest.findFirst({ where: { orderId, status: "APPROVED" }, select: { id: true } });
    if (approvedRefund) throw new ApiError("A refund has been approved for this order, so its cancellation can not be reverted.", STATUS_CODES.CONFLICT);

    const meta = (order.metadata as Record<string, unknown> | null) ?? {};
    const previous = meta.preCancelStatus;
    if (typeof previous !== "string" || previous === "CANCELLED" || !(previous in OrderStatus)) {
      throw new ApiError("The status before cancellation was not recorded for this order (it was cancelled before reverting was supported), so it cannot be restored automatically.", STATUS_CODES.CONFLICT);
    }
    const restoredStatus = previous as OrderStatus;

    // Conditional on still being CANCELLED, so two concurrent reverts (a double click) cannot both win.
    const { count } = await this.db.order.updateMany({ where: { id: orderId, status: "CANCELLED" }, data: { status: restoredStatus, cancelledAt: null, cancelReason: null } });
    if (count === 0) return { order: await this.getOrder(user, orderId), restoredStatus, alreadyActive: true };
    clearLiveOrderCaches();

    const { preCancelStatus: _consumed, ...rest } = meta;
    await this.db.order.update({ where: { id: orderId }, data: { metadata: { ...rest, cancellationReverted: { at: new Date().toISOString(), by: user.id, restoredStatus } } as Prisma.InputJsonValue } });
    await this.db.activity.create({
      data: {
        leadId: order.leadId,
        orderId,
        actorId: user.id,
        actorRole: user.role,
        type: ActivityType.ORDER_STATUS_CHANGED,
        referenceType: ORDER_REFERENCE_TYPE,
        referenceId: orderId,
        source: ActivitySource.USER,
        title: "Order cancellation reverted",
        description: `Restored from Cancelled to ${restoredStatus}`,
      },
    });

    return { order: await this.getOrder(user, orderId), restoredStatus, alreadyActive: false };
  }

  // Foundation only: there is no status-history table yet, so this combines recorded
  // Activity rows that point at the order with the milestone timestamps on the order row.
  // Neither stores the previous/new status, which needs a schema change (see E6 notes).
  async getStatusHistory(user: AuthUser, id: string): Promise<OrderStatusHistory> {
    const leadScope = await getLeadScope(user, this.db);
    const order = await this.db.order.findFirst({
      where: orderReadWhere(user, id, leadScope),
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
    const leadSources = (await this.db.source.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })).map((s) => ({ id: s.id, name: s.name }));
    const people = await this.getSalespeopleOptions(user);
    return { salespeople: people, leadSources };
  }

  private async getSalespeopleOptions(user: AuthUser): Promise<{ id: string; name: string }[]> {
    if (user.role === Role.SALESPERSON) {
      return [];
    }

    if (user.role === Role.ADMIN) {
      const users = await this.db.user.findMany({
        where: { role: { in: [Role.SALESPERSON, Role.MANAGER] } },
        select: { id: true, name: true, status: true },
        orderBy: { name: "asc" },
      });
      return users.map((u) => ({
        id: u.id,
        name: u.status === UserStatus.ACTIVE ? u.name : `${u.name} (inactive)`,
      }));
    }

    const team = await getManagerTeam(user.id, this.db);
    const self = await this.db.user.findUnique({ where: { id: user.id }, select: { id: true, name: true } });
    const people = new Map(team.members.map((m) => [m.id, m]));
    if (self) people.set(self.id, self);

    return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

export default OrdersService;
