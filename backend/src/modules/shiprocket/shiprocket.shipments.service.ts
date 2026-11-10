import { readShipToAddress } from "./shiprocket.address.js";
import { mergeShiprocketSync } from "./shiprocket.sync-record.js";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import { getLeadScope } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, OrderStatus, PaymentStatus, ShipmentStatus, type Role } from "../../../generated/prisma/enums.js";
import { logger } from "@/utils/logger.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { computePaymentBreakdown, derivePaymentMode, fullName, scopedOrderWhere } from "../orders/orders.filters.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { advisoryLock, asRecord, ProviderHttpError, safeMessage, toTenDigitMobile, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { applyShipmentUpdate, shipmentOrderLockKey, SHIPMENT_REFERENCE_TYPE } from "./shiprocket.apply.js";
import { ShiprocketClient, type CancelReply, type CourierOption, type CreateOrderRequest, type CreatedOrder, type ShiprocketOrderLookup } from "./shiprocket.client.js";
import { channelIdsFor, describeRemoteTwins, findLiveRemoteOrders } from "./shiprocket.duplicates.js";
import { channelOrderIdFor, decideChannelRef, type ChannelRefDecision } from "./shiprocket.channel-ref.js";
import { confirmShiprocketCancellation, isCancelledText, mergeShiprocketCancellation, planCancellation, readShiprocketCancellation, type ShiprocketCancelStatus, type ShiprocketCancellationRecord } from "./shiprocket.cancellation.js";
import { isShiprocketEnabled, loadShiprocketConfig, ShiprocketConfigError, type ShiprocketConfig } from "./shiprocket.config.js";
import { mapShiprocketStatus, parseEtd } from "./shiprocket.events.js";
import { buildShipmentListWhere, buildShipmentSummary, mapShipmentDetailRow, mapShipmentListRow, scopedShipmentWhere, SHIPROCKET_SOURCE } from "./shiprocket.list.filters.js";
import { getLiveTrackingBatch } from "./shiprocket.live-tracking.js";
import type { ListShipmentsQuery, ListShipmentsResult, ShipmentDetailResult, ShipmentFilterOptions } from "./shiprocket.types.js";

// Creates and drives Shiprocket shipments for an existing CRM order (Shopify-sourced or otherwise). The Shipment row is
// tagged externalSource SHIPROCKET, which is what keeps Shopify sync from ever reading, overwriting or deleting it; the
// Shopify-derived shipment for the same parcel (if any) stays a separate row and is linked by AWB when displayed.

export interface ShiprocketApi {
  createOrder(request: CreateOrderRequest): Promise<CreatedOrder>;
  /** Read-only search by channel order id; used to refuse creating an order Shiprocket already holds. Optional so a stand-in without it simply skips that check. */
  findOrdersByChannelId?(channelOrderId: string): Promise<ShiprocketOrderLookup[]>;
  getCouriers(shiprocketOrderId: string): Promise<CourierOption[]>;
  assignAwb(shipmentId: string, courierId: number): Promise<{ awb: string; courierName: string | null; courierCompanyId: number | null }>;
  generatePickup(shipmentId: string): Promise<{ scheduledDate: string | null; tokenNumber: string | null }>;
  generateLabel(shipmentId: string): Promise<string>;
  track(awb: string): Promise<{ awb: string; currentStatus: string | null; trackUrl: string | null; etd: string | null; courierName: string | null } | null>;
}

/** The three Shiprocket calls cancellation uses (a separate interface, so the creation / tracking fakes need not know about it). */
export interface ShiprocketCancelApi {
  cancelOrders(shiprocketOrderIds: string[]): Promise<CancelReply>;
  cancelAwbs(awbs: string[]): Promise<CancelReply>;
  getOrderStatus(shiprocketOrderId: string): Promise<string | null>;
}

export interface ShiprocketCancelOutcome {
  status: ShiprocketCancelStatus | "NOT_APPLICABLE";
  reason?: string;
  record: ShiprocketCancellationRecord | null;
}

export interface ShipmentInput {
  weight: number;
  length: number;
  breadth: number;
  height: number;
  /** Set to create another shipment even though the previous attempt's outcome at Shiprocket is unknown. */
  acknowledgeUnconfirmed?: boolean;
}

export interface ShipmentResult {
  id: string;
  orderId: string;
  status: ShipmentStatus;
  providerStatus: string | null;
  courier: string | null;
  awb: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  pickupScheduledAt: Date | null;
  expectedDeliveryAt: Date | null;
  shiprocketOrderId: string | null;
  /** The parcel weight (kg) the shipment was created with - the same one used to check courier availability. Null on older shipments. */
  weightKg: string | null;
  /** Only on creation: how Shiprocket was told to collect payment. */
  paymentMethod?: "Prepaid" | "COD";
  collectOnDelivery?: string;
}

export interface ShipmentServiceDeps {
  config?: () => ShiprocketConfig;
  client?: (config: ShiprocketConfig) => ShiprocketApi;
  cancelClient?: (config: ShiprocketConfig) => ShiprocketCancelApi;
  now?: () => Date;
}

const BLOCKED_ORDER_STATUSES = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.RETURNED]);
const BAD_GATEWAY = 502;
const STALE_RESERVATION_MS = 2 * 60_000;

const SHIPMENT_SELECT = {
  id: true,
  orderId: true,
  status: true,
  providerStatus: true,
  courier: true,
  trackingNumber: true,
  trackingUrl: true,
  labelUrl: true,
  pickupScheduledAt: true,
  expectedDeliveryAt: true,
  providerOrderId: true,
  courierCompanyId: true,
  weightKg: true,
  externalSource: true,
  externalId: true,
  metadata: true,
  order: { select: { id: true, leadId: true, orderNumber: true } },
} satisfies Prisma.ShipmentSelect;

type ShipmentRow = Prisma.ShipmentGetPayload<{ select: typeof SHIPMENT_SELECT }>;

// For the centralized listing/tracking page (Order -> customer/payment/destination come from the order the same way
// the order detail page already reads them). Lead is always read through an explicit `select`, never bare `include`,
// the same convention every other module in this codebase follows.
const ORDER_SUMMARY_SELECT = {
  id: true,
  orderNumber: true,
  externalNumber: true,
  source: true,
  currency: true,
  totalAmount: true,
  shippingAddress: true,
  payments: { select: { method: true } },
  lead: { select: { id: true, leadNumber: true, firstName: true, lastName: true, mobile: true } },
} satisfies Prisma.OrderSelect;

const LIST_SELECT = {
  id: true,
  status: true,
  providerStatus: true,
  courier: true,
  trackingNumber: true,
  createdAt: true,
  updatedAt: true,
  order: { select: ORDER_SUMMARY_SELECT },
} satisfies Prisma.ShipmentSelect;

const DETAIL_SELECT = {
  ...LIST_SELECT,
  trackingUrl: true,
  labelUrl: true,
  pickupScheduledAt: true,
  expectedDeliveryAt: true,
  shippedAt: true,
  deliveredAt: true,
  returnedAt: true,
  providerOrderId: true,
  channelOrderId: true,
  order: { select: { ...ORDER_SUMMARY_SELECT, lead: { select: { ...ORDER_SUMMARY_SELECT.lead.select, email: true } } } },
} satisfies Prisma.ShipmentSelect;

const toResult = (s: ShipmentRow): ShipmentResult => ({
  id: s.id,
  orderId: s.orderId,
  status: s.status,
  providerStatus: s.providerStatus,
  courier: s.courier,
  awb: s.trackingNumber,
  trackingUrl: s.trackingUrl,
  labelUrl: s.labelUrl,
  pickupScheduledAt: s.pickupScheduledAt,
  expectedDeliveryAt: s.expectedDeliveryAt,
  shiprocketOrderId: s.providerOrderId,
  weightKg: s.weightKg ? s.weightKg.toString() : null,
});

/** A provider failure as the CRM reports it: a problem with what was sent is a 400 the user can act on; anything else is a bad gateway. */
export function providerFailure(error: unknown, action: string): ApiError {
  if (error instanceof ProviderHttpError) {
    if (error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429) {
      return new ApiError(`Shiprocket could not ${action}: ${error.message}`, STATUS_CODES.BAD_REQUEST);
    }
    return new ApiError(error.retryable ? `Shiprocket could not be reached to ${action}. Try again in a moment.` : `Shiprocket could not ${action}: ${error.message}`, BAD_GATEWAY);
  }
  return new ApiError(`Shiprocket returned an unexpected answer while trying to ${action}.`, BAD_GATEWAY);
}

interface OrderForShipment {
  orderNumber: string;
  placedAt: Date | null;
  createdAt: Date;
  currency: string;
  totalAmount: { toString(): string };
  discountAmount: { toString(): string };
  shippingAmount: { toString(): string };
  shippingAddress: unknown;
  /** The order's own saved pincode column, used only when the address object carries none. */
  shippingPincode?: string | null;
  lead: { firstName: string; lastName: string | null; mobile: string | null; normalizedMobile: string | null; email: string | null };
  items: { productNameSnapshot: string; variantNameSnapshot: string | null; skuSnapshot: string | null; quantity: number; unitPrice: { toString(): string }; discountAmount: { toString(): string }; taxAmount: { toString(): string } }[];
  payments: { status: PaymentStatus; amount: { toString(): string }; refundedAmount: { toString(): string } | null }[];
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Shiprocket's "YYYY-MM-DD HH:mm" order date, in India Standard Time. */
export function formatOrderDate(date: Date): string {
  const ist = new Date(date.getTime() + 5.5 * 3_600_000);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`;
}

/** Everything Shiprocket needs, built from the CRM order - or a plain list of what is missing so the user can fix it. */
export function buildShiprocketOrder(order: OrderForShipment, input: ShipmentInput, pickupLocation: string, channelOrderId: string): { request: CreateOrderRequest; collectCents: number } {
  // The address as the CRM actually saved it (the order address editor and Create Order save line1 / state / pincode; Shopify-synced orders save address1 / province / zip) - see shiprocket.address.ts.
  const shipTo = readShipToAddress(order.shippingAddress, order.shippingPincode);
  const missing: string[] = shipTo.ok ? [] : [...shipTo.missing];
  const address = shipTo.ok ? shipTo.address : null;
  const name = (address?.name ?? "").trim() || fullName(order.lead.firstName, order.lead.lastName);
  const phone = toTenDigitMobile(address?.phone) ?? toTenDigitMobile(order.lead.normalizedMobile) ?? toTenDigitMobile(order.lead.mobile);
  if (!phone) missing.push("10-digit phone number");
  if (order.items.length === 0) missing.push("order items");
  if (!address || missing.length > 0) throw new ApiError(`This order can not be shipped yet - missing: ${missing.join(", ")}`, STATUS_CODES.BAD_REQUEST);

  const [first, ...rest] = name.split(/\s+/);
  const breakdown = computePaymentBreakdown(order.payments);
  const totalCents = toCents(order.totalAmount.toString());
  // Anything not yet paid is collected by the courier on delivery; a fully paid order ships as prepaid.
  const collectCents = Math.max(totalCents - breakdown.paidCents - breakdown.refundedCents, 0);

  const request: CreateOrderRequest = {
    order_id: channelOrderId,
    order_date: formatOrderDate(order.placedAt ?? order.createdAt),
    pickup_location: pickupLocation,
    billing_customer_name: first,
    billing_last_name: rest.join(" "),
    billing_address: address.line1,
    ...(address.line2 ? { billing_address_2: address.line2 } : {}),
    billing_city: address.city,
    billing_pincode: address.pincode,
    billing_state: address.state,
    billing_country: address.country || "India",
    billing_email: order.lead.email ?? "",
    billing_phone: phone!,
    shipping_is_billing: true,
    order_items: order.items.map((item) => ({
      name: (item.variantNameSnapshot ? `${item.productNameSnapshot} - ${item.variantNameSnapshot}` : item.productNameSnapshot).slice(0, 200),
      sku: item.skuSnapshot ?? item.productNameSnapshot.slice(0, 50),
      units: item.quantity,
      selling_price: Number(item.unitPrice.toString()),
      discount: Number(item.discountAmount.toString()),
      tax: Number(item.taxAmount.toString()),
    })),
    payment_method: collectCents > 0 ? "COD" : "Prepaid",
    shipping_charges: Number(order.shippingAmount.toString()),
    total_discount: Number(order.discountAmount.toString()),
    sub_total: collectCents > 0 ? collectCents / 100 : totalCents / 100,
    length: input.length,
    breadth: input.breadth,
    height: input.height,
    weight: input.weight,
  };
  return { request, collectCents };
}

class ShiprocketShipmentsService {
  constructor(
    private readonly runner: TxRunner = prisma,
    private readonly deps: ShipmentServiceDeps = {},
  ) {}

  private config(): ShiprocketConfig {
    try {
      return (this.deps.config ?? loadShiprocketConfig)();
    } catch (error) {
      if (error instanceof ShiprocketConfigError) throw new ApiError(error.message, STATUS_CODES.SERVICE_UNAVAILABLE);
      throw error;
    }
  }

  private api(config: ShiprocketConfig): ShiprocketApi {
    return this.deps.client ? this.deps.client(config) : new ShiprocketClient(config);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  // ---------------------------------------------------------------- cancellation

  /**
   * Cancels the Shiprocket order of a CRM order that has just been cancelled (or retries a cancellation that did not finish). Never throws and never touches the CRM order.
   *
   *  - Uses the stored Shiprocket order id of the order's latest Shiprocket shipment - never the CRM order number or the channel order id.
   *  - No AWB: POST /orders/cancel. With an AWB (courier booked, not yet picked up): the AWB booking is cancelled first, then the order. Picked up / on its way / delivered: nothing is sent, the reason is recorded.
   *  - Once per order: the claim below (under the order's lock) is PENDING, so a second click or a concurrent retry sends nothing. A request Shiprocket accepted is REQUESTED and is never re-sent; a later call only checks.
   *  - "Cancelled" is only recorded when Shiprocket itself shows the order as cancelled (read back here, or its tracking webhook, see applyShipmentUpdate).
   *  - An unreachable / refusing Shiprocket leaves the record FAILED with Shiprocket's own text; calling this again retries (it first checks whether an earlier request in fact went through).
   */
  async cancelForOrder(orderId: string, actor?: { id: string; role: Role } | null): Promise<ShiprocketCancelOutcome> {
    try {
      return await this.cancelForOrderUnsafe(orderId, actor ?? null);
    } catch (error) {
      const reason = safeMessage(error instanceof Error ? error.message : String(error));
      logger.warn(`Shiprocket cancellation errored for order ${orderId}: ${reason}`);
      return { status: "FAILED", reason, record: null };
    }
  }

  private async cancelForOrderUnsafe(orderId: string, actor: { id: string; role: Role } | null): Promise<ShiprocketCancelOutcome> {
    const now = this.now();
    const read = () => this.runner.$transaction(async (tx) => readShiprocketCancellation((await tx.order.findUnique({ where: { id: orderId }, select: { metadata: true } }))?.metadata));
    const done = async (status: ShiprocketCancelOutcome["status"], reason?: string): Promise<ShiprocketCancelOutcome> => ({ status, reason, record: await read() });

    // Phase 1 (locked): decide, and claim the request so nobody else sends it.
    const claim = await this.runner.$transaction(async (tx) => {
      await advisoryLock(tx, shipmentOrderLockKey(orderId));
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { metadata: true, shipments: { where: { externalSource: "SHIPROCKET" }, orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, providerStatus: true, providerOrderId: true, externalId: true, trackingNumber: true } } },
      });
      if (!order) return { kind: "end" as const, status: "NOT_APPLICABLE" as const };
      const shipment = order.shipments[0] ?? null;
      const plan = planCancellation(shipment);
      if (plan.kind === "none") return { kind: "end" as const, status: "NOT_APPLICABLE" as const };
      if (plan.kind === "submitting") {
        const reason = "The order is still being submitted to Shiprocket, so there is nothing to cancel yet. Cancel it again in a moment.";
        await mergeShiprocketCancellation(tx, orderId, { status: "FAILED", error: reason, lastAttemptAt: now.toISOString() });
        return { kind: "end" as const, status: "FAILED" as const, reason };
      }
      const prior = readShiprocketCancellation(order.metadata);
      const same = prior !== null && prior.shiprocketOrderId === plan.shiprocketOrderId;
      if (same && prior.status === "CANCELLED") return { kind: "end" as const, status: "CANCELLED" as const };
      // A new cancellation cycle (the order was re-submitted to Shiprocket after an earlier one) starts from a clean record.
      const fresh: Partial<ShiprocketCancellationRecord> = same ? {} : { attempts: 0, requestedAt: null, cancelledAt: null, awbCancelled: false, response: null, awbResponse: null };
      const ids: Partial<ShiprocketCancellationRecord> = { shiprocketOrderId: plan.shiprocketOrderId, awb: shipment!.trackingNumber ?? null };

      if (plan.kind === "already_cancelled") {
        await mergeShiprocketCancellation(tx, orderId, { ...fresh, ...ids, status: "CANCELLED", cancelledAt: prior?.cancelledAt ?? now.toISOString(), error: null });
        return { kind: "end" as const, status: "CANCELLED" as const, reason: "Shiprocket already shows this order as cancelled" };
      }
      if (plan.kind === "too_far") {
        await mergeShiprocketCancellation(tx, orderId, { ...fresh, ...ids, status: "FAILED", error: plan.reason, lastAttemptAt: now.toISOString() });
        return { kind: "end" as const, status: "FAILED" as const, reason: plan.reason };
      }
      if (same && prior.status === "PENDING" && prior.lastAttemptAt && now.getTime() - new Date(prior.lastAttemptAt).getTime() < STALE_RESERVATION_MS) {
        return { kind: "end" as const, status: "PENDING" as const, reason: "A cancellation request for this order is already in progress" };
      }
      if (same && prior.status === "REQUESTED") return { kind: "check" as const, shiprocketOrderId: plan.shiprocketOrderId, shipmentId: shipment!.id };
      const attempts = (same ? prior.attempts : 0) + 1;
      await mergeShiprocketCancellation(tx, orderId, { ...fresh, ...ids, status: "PENDING", attempts, lastAttemptAt: now.toISOString(), error: null });
      return { kind: "send" as const, shiprocketOrderId: plan.shiprocketOrderId, shipmentId: shipment!.id, awb: plan.awb, attempts, awbCancelled: same && prior.awbCancelled };
    });
    if (claim.kind === "end") return done(claim.status, "reason" in claim ? claim.reason : undefined);

    let api: ShiprocketCancelApi;
    try {
      const config = this.config();
      api = this.deps.cancelClient ? this.deps.cancelClient(config) : new ShiprocketClient(config);
    } catch (error) {
      const reason = safeMessage(error instanceof Error ? error.message : String(error));
      if (claim.kind === "send") await this.runner.$transaction((tx) => mergeShiprocketCancellation(tx, orderId, { status: "FAILED", error: reason }));
      return done(claim.kind === "send" ? "FAILED" : "REQUESTED", reason);
    }

    const confirmed = async (): Promise<boolean> => isCancelledText(await api.getOrderStatus(claim.shiprocketOrderId));
    const markCancelled = async (): Promise<ShiprocketCancelOutcome> => {
      await this.runner.$transaction(async (tx) => {
        await applyShipmentUpdate(tx, claim.shipmentId, { status: ShipmentStatus.CANCELLED, providerStatus: "CANCELED" }, { source: actor ? ActivitySource.USER : ActivitySource.SYSTEM, actor, now });
        await confirmShiprocketCancellation(tx, orderId, now);
      });
      return done("CANCELLED");
    };

    if (claim.kind === "check") {
      // Accepted earlier; never re-sent. Only look at what Shiprocket shows now.
      try {
        if (await confirmed()) return await markCancelled();
      } catch {
        // Shiprocket could not be read: still requested, not confirmed.
      }
      return done("REQUESTED", "Shiprocket has accepted the cancellation but does not show the order as cancelled yet");
    }

    const fail = async (step: string, error: unknown): Promise<ShiprocketCancelOutcome> => {
      const detail = error instanceof ProviderHttpError ? error.message : error instanceof Error ? safeMessage(error.message) : "Unexpected answer";
      const reason = `${step}: ${detail}`.slice(0, 500);
      await this.runner.$transaction((tx) => mergeShiprocketCancellation(tx, orderId, { status: "FAILED", error: reason }));
      return done("FAILED", reason);
    };

    // A retry first asks Shiprocket: an earlier request may have gone through even though its reply was lost.
    if (claim.attempts > 1) {
      try {
        if (await confirmed()) return await markCancelled();
      } catch {
        // could not read; carry on with the request
      }
    }
    try {
      if (claim.awb && !claim.awbCancelled) {
        const reply = await api.cancelAwbs([claim.awb]);
        await this.runner.$transaction((tx) => mergeShiprocketCancellation(tx, orderId, { awbCancelled: true, awbResponse: reply.raw }));
      }
    } catch (error) {
      return fail("Shiprocket would not cancel the courier booking (AWB)", error);
    }
    try {
      const reply = await api.cancelOrders([claim.shiprocketOrderId]);
      await this.runner.$transaction((tx) => mergeShiprocketCancellation(tx, orderId, { status: "REQUESTED", requestedAt: now.toISOString(), response: reply.raw, error: null }));
    } catch (error) {
      return fail("Shiprocket did not cancel the order", error);
    }
    try {
      if (await confirmed()) return await markCancelled();
    } catch {
      // accepted but not yet confirmable
    }
    return done("REQUESTED", "Cancellation requested; Shiprocket does not show the order as cancelled yet");
  }

  /** Whether Shiprocket is switched on and complete - never returns credentials. */
  status(): { enabled: boolean; configured: boolean } {
    if (!isShiprocketEnabled()) return { enabled: false, configured: false };
    try {
      this.config();
      return { enabled: true, configured: true };
    } catch {
      return { enabled: true, configured: false };
    }
  }

  private async loadShipment(tx: Db, user: AuthUser, shipmentId: string): Promise<ShipmentRow> {
    const scope = await getLeadScope(user, tx);
    const shipment = await tx.shipment.findFirst({
      where: { id: shipmentId, externalSource: "SHIPROCKET", ...(Object.keys(scope).length > 0 ? { order: { lead: scope } } : {}) },
      select: SHIPMENT_SELECT,
    });
    if (!shipment) throw new ApiError("Shipment not found", STATUS_CODES.NOT_FOUND);
    return shipment;
  }

  private async reload(shipmentId: string): Promise<ShipmentResult> {
    return this.runner.$transaction(async (tx) => toResult(await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, select: SHIPMENT_SELECT })));
  }

  // ---------------------------------------------------------------- create

  /** `system: true` = the automatic submission of a CRM-created order: the order is found without the caller's lead scope (the creator may only see the order through the WhatsApp inbox); every other rule is the same. */
  async createShipment(user: AuthUser, orderId: string, input: ShipmentInput, opts: { system?: boolean } = {}): Promise<ShipmentResult> {
    const config = this.config();
    const prepared = await this.runner.$transaction((tx) => this.prepare(tx, user, orderId, input, config, opts.system === true));

    const api = this.api(config);
    await this.refuseIfShiprocketHasIt(api, prepared);

    let created: CreatedOrder;
    try {
      created = await api.createOrder(prepared.request);
    } catch (error) {
      await this.recordCreationFailure(prepared.shipmentId, error);
      throw providerFailure(error, "create the shipment");
    }

    const ref: ChannelRefDecision = prepared.ref;
    const mapping = ref.kind === "SHOPIFY" ? { shopifyOrderId: ref.shopifyOrderId, shopifyOrderName: ref.shopifyOrderName } : {};
    await this.runner.$transaction(async (tx) => {
      await advisoryLock(tx, shipmentOrderLockKey(orderId));
      await tx.shipment.update({
        where: { id: prepared.shipmentId },
        data: {
          externalId: created.shipmentId,
          providerOrderId: created.orderId,
          status: created.awb ? ShipmentStatus.AWB_ASSIGNED : ShipmentStatus.CREATED,
          trackingNumber: created.awb,
          courier: created.courierName,
          courierCompanyId: created.courierCompanyId,
          metadata: { shiprocket: { created: true, channelOrderId: prepared.request.order_id, crmOrderNumber: prepared.orderNumber, ...mapping } },
        },
      });
      // The order's Shiprocket status (shown on the order page) - for the automatic submission, a retry and a shipment created by hand alike.
      await mergeShiprocketSync(tx, orderId, { status: "SYNCED", syncedAt: this.now().toISOString(), lastAttemptAt: this.now().toISOString(), shiprocketOrderId: created.orderId ?? null, channelOrderId: prepared.request.order_id, crmOrderNumber: prepared.orderNumber, shopifyOrderId: mapping.shopifyOrderId ?? null, shopifyOrderName: mapping.shopifyOrderName ?? null, error: null });
      await tx.activity.create({
        data: {
          leadId: prepared.leadId,
          orderId,
          actorId: user.id,
          actorRole: user.role,
          type: ActivityType.SHIPMENT_CREATED,
          referenceType: SHIPMENT_REFERENCE_TYPE,
          referenceId: prepared.shipmentId,
          source: ActivitySource.USER,
          title: `Shiprocket shipment created for order ${prepared.orderNumber}`,
          newValue: { status: created.awb ? ShipmentStatus.AWB_ASSIGNED : ShipmentStatus.CREATED, paymentMethod: prepared.request.payment_method },
          metadata: { provider: "SHIPROCKET", providerShipmentId: created.shipmentId },
        },
      });
    });

    return { ...(await this.reload(prepared.shipmentId)), paymentMethod: prepared.request.payment_method, collectOnDelivery: fromCents(prepared.collectCents) };
  }

  /** Phase 1 (locked): validate, build the Shiprocket order, and reserve a Shipment row so a second click finds it. Nothing is sent yet. */
  private async prepare(tx: Db, user: AuthUser, orderId: string, input: ShipmentInput, config: ShiprocketConfig, system = false) {
    await advisoryLock(tx, shipmentOrderLockKey(orderId));
    const scope = system ? {} : await getLeadScope(user, tx);
    const order = await tx.order.findFirst({
      where: scopedOrderWhere(orderId, scope),
      select: {
        id: true,
        orderNumber: true,
        externalNumber: true,
        externalId: true,
        source: true,
        metadata: true,
        status: true,
        placedAt: true,
        createdAt: true,
        currency: true,
        totalAmount: true,
        discountAmount: true,
        shippingAmount: true,
        shippingAddress: true,
        shippingPincode: true,
        lead: { select: { id: true, firstName: true, lastName: true, mobile: true, normalizedMobile: true, email: true } },
        items: { select: { productNameSnapshot: true, variantNameSnapshot: true, skuSnapshot: true, quantity: true, unitPrice: true, discountAmount: true, taxAmount: true } },
        payments: { select: { status: true, method: true, amount: true, refundedAmount: true } },
        shipments: { where: { externalSource: "SHIPROCKET" }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, metadata: true, externalId: true, createdAt: true } },
      },
    });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    if (BLOCKED_ORDER_STATUSES.has(order.status)) throw new ApiError(`A shipment can not be created for a ${order.status.toLowerCase()} order`, STATUS_CODES.BAD_REQUEST);

    // A prepaid order (any PAYMENT_LINK payment) is not ready for fulfilment until Cashfree actually confirms one of
    // them SUCCESS - enforced here, not just left to the UI, so this can never be bypassed by calling the API directly.
    // A COD order has no such gate: COD money is collected on delivery by design.
    if (derivePaymentMode(order.payments) === "PREPAID" && !order.payments.some((p) => p.status === PaymentStatus.SUCCESS)) {
      throw new ApiError("This order is prepaid and payment has not been confirmed yet - a shipment can only be created once payment succeeds.", STATUS_CODES.BAD_REQUEST);
    }

    // A reserved row that never got a Shiprocket id is a creation that died half-way (a crash between reserving the row
    // and hearing back). Nobody can act on it, so after a grace period it is closed as "outcome unknown" instead of
    // blocking the order for good.
    const now = this.now();
    for (const s of order.shipments) {
      if (s.status === ShipmentStatus.CREATED && s.externalId?.startsWith("pending:") && now.getTime() - s.createdAt.getTime() > STALE_RESERVATION_MS) {
        await tx.shipment.update({ where: { id: s.id }, data: { status: ShipmentStatus.CANCELLED, metadata: { shiprocket: { creationFailed: true, creationUnconfirmed: true, error: "No reply was recorded" } } } });
        s.status = ShipmentStatus.CANCELLED;
        s.metadata = { shiprocket: { creationUnconfirmed: true } };
      }
    }
    const live = order.shipments.find((s) => s.status !== ShipmentStatus.CANCELLED && s.status !== ShipmentStatus.RETURNED);
    if (live) throw new ApiError("This order already has an active Shiprocket shipment", STATUS_CODES.CONFLICT);
    const unconfirmed = order.shipments.find((s) => asRecord(asRecord(s.metadata).shiprocket).creationUnconfirmed === true);
    if (unconfirmed && !input.acknowledgeUnconfirmed) {
      throw new ApiError("A previous attempt to create this shipment did not get a reply, so it may already exist in Shiprocket. Check the Shiprocket panel, then confirm to create another.", STATUS_CODES.CONFLICT);
    }

    // A CRM order that is a Shopify order is registered under its SHOPIFY reference; one still waiting for its Shopify order is not registered at all (a second route into Shiprocket would be the duplicate).
    const ref = decideChannelRef(order);
    if (ref.kind === "WAIT_FOR_SHOPIFY") throw new ApiError(`${ref.reason} Nothing was sent to Shiprocket.`, STATUS_CODES.CONFLICT);

    const shipmentId = randomUUID();
    // The first submission of an order uses the base id itself (Shopify reference, or the CRM order number). Any later one (after a cancelled / failed attempt) keeps a suffix, so the two never share an id.
    const channelOrderId = channelOrderIdFor(ref.base, order.shipments.length, shipmentId.slice(0, 8));
    const { request: built, collectCents } = buildShiprocketOrder(order, input, config.pickupLocation, channelOrderId);
    const request: CreateOrderRequest = ref.kind === "SHOPIFY" ? { ...built, comment: `CRM order ${order.orderNumber}`.slice(0, 200) } : built;

    await tx.shipment.create({
      data: {
        id: shipmentId,
        orderId: order.id,
        status: ShipmentStatus.CREATED,
        externalSource: "SHIPROCKET",
        externalId: `pending:${shipmentId}`,
        channelOrderId,
        weightKg: input.weight, // the parcel weight entered for this shipment, exactly as sent to Shiprocket
        metadata: { shiprocket: { creating: true, crmOrderNumber: order.orderNumber, ...(ref.kind === "SHOPIFY" ? { shopifyOrderId: ref.shopifyOrderId, shopifyOrderName: ref.shopifyOrderName } : {}) } },
      },
    });
    await tx.order.update({ where: { id: order.id }, data: { parcelWeightKg: input.weight } });
    return { shipmentId, request, collectCents, orderNumber: order.orderNumber, externalNumber: order.externalNumber ?? null, hadEarlierAttempt: order.shipments.length > 0, leadId: order.lead.id, ref };
  }

  /**
   * Last check before anything is sent: does Shiprocket already hold a live order for this sale? Searched by the id this request would use, the CRM order number and - when the CRM order is linked
   * to Shopify - the Shopify name (the store's Shopify-Shiprocket channel imports Shopify orders under that name). If one exists the reservation is closed and NOTHING is created: the existing
   * order is reported for a person to use or cancel. A failed search lets a first attempt go ahead (the order lock and the one-live-shipment rule still apply) but blocks a retry after an
   * earlier attempt, because that is exactly when a lost reply may have left an order behind.
   */
  private async refuseIfShiprocketHasIt(api: ShiprocketApi, prepared: { shipmentId: string; orderNumber: string; externalNumber: string | null; hadEarlierAttempt: boolean; request: CreateOrderRequest }): Promise<void> {
    if (!api.findOrdersByChannelId) return;
    let twins: ShiprocketOrderLookup[];
    try {
      twins = await findLiveRemoteOrders((id) => api.findOrdersByChannelId!(id), channelIdsFor({ orderNumber: prepared.orderNumber, externalNumber: prepared.externalNumber }, [prepared.request.order_id]));
    } catch (error) {
      if (!prepared.hadEarlierAttempt) {
        logger.warn(`Shiprocket duplicate check could not run for order ${prepared.orderNumber}: ${safeMessage(error instanceof Error ? error.message : String(error))}`);
        return;
      }
      await this.closeReservation(prepared.shipmentId, { error: "Could not check Shiprocket for an existing order", creationUnconfirmed: true });
      throw new ApiError("Shiprocket could not be checked for an order created by an earlier attempt, so nothing was sent. Try again in a moment.", STATUS_CODES.CONFLICT);
    }
    if (twins.length === 0) return;
    await this.closeReservation(prepared.shipmentId, { error: describeRemoteTwins(twins).slice(0, 500), existingShiprocketOrderIds: twins.map((t) => t.shiprocketOrderId), duplicateBlocked: true });
    throw new ApiError(describeRemoteTwins(twins), STATUS_CODES.CONFLICT);
  }

  private async closeReservation(shipmentId: string, info: Record<string, unknown>): Promise<void> {
    await this.runner.$transaction((tx) => tx.shipment.update({ where: { id: shipmentId }, data: { status: ShipmentStatus.CANCELLED, metadata: { shiprocket: { creationFailed: true, creationUnconfirmed: false, ...info } } } }));
  }

  /** The reserved row must never look like a live shipment when Shiprocket did not confirm it. */
  private async recordCreationFailure(shipmentId: string, error: unknown): Promise<void> {
    // A definite refusal (4xx) means nothing exists at Shiprocket. Anything else (timeout, 5xx, garbled reply) is unknown.
    const definite = error instanceof ProviderHttpError && error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 429;
    await this.runner.$transaction((tx) =>
      tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: ShipmentStatus.CANCELLED,
          metadata: { shiprocket: { creationFailed: true, creationUnconfirmed: !definite, error: error instanceof ProviderHttpError ? error.message : "Unexpected answer" } },
        },
      }),
    );
  }

  // ---------------------------------------------------------------- couriers / AWB / pickup / label / tracking

  async getCouriers(user: AuthUser, shipmentId: string): Promise<CourierOption[]> {
    const config = this.config();
    const shipment = await this.runner.$transaction((tx) => this.loadShipment(tx, user, shipmentId));
    if (!shipment.providerOrderId) throw new ApiError("This shipment has no Shiprocket order yet", STATUS_CODES.CONFLICT);
    try {
      return await this.api(config).getCouriers(shipment.providerOrderId);
    } catch (error) {
      throw providerFailure(error, "list couriers");
    }
  }

  async assignAwb(user: AuthUser, shipmentId: string, courierId: number): Promise<ShipmentResult> {
    const config = this.config();
    const shipment = await this.runner.$transaction((tx) => this.loadShipment(tx, user, shipmentId));
    if (shipment.trackingNumber) return toResult(shipment); // already assigned: nothing to do, nothing to repeat at Shiprocket
    if (shipment.status !== ShipmentStatus.CREATED) throw new ApiError(`An AWB can not be assigned to a ${shipment.status.toLowerCase()} shipment`, STATUS_CODES.CONFLICT);

    let assigned;
    try {
      assigned = await this.api(config).assignAwb(shipment.externalId!, courierId);
    } catch (error) {
      throw providerFailure(error, "assign an AWB");
    }
    await this.runner.$transaction((tx) =>
      applyShipmentUpdate(
        tx,
        shipmentId,
        { status: ShipmentStatus.AWB_ASSIGNED, awb: assigned.awb, courier: assigned.courierName, courierCompanyId: assigned.courierCompanyId ?? courierId, activity: { type: ActivityType.SHIPMENT_AWB_ASSIGNED, title: `AWB ${assigned.awb} assigned for order ${shipment.order.orderNumber}` } },
        { source: ActivitySource.USER, actor: user, now: this.now() },
      ),
    );
    return this.reload(shipmentId);
  }

  async schedulePickup(user: AuthUser, shipmentId: string): Promise<ShipmentResult> {
    const config = this.config();
    const shipment = await this.runner.$transaction((tx) => this.loadShipment(tx, user, shipmentId));
    if (shipment.status === ShipmentStatus.PICKUP_SCHEDULED) return toResult(shipment);
    if (shipment.status !== ShipmentStatus.AWB_ASSIGNED || !shipment.trackingNumber) throw new ApiError("Assign an AWB before scheduling a pickup", STATUS_CODES.CONFLICT);

    let pickup;
    try {
      pickup = await this.api(config).generatePickup(shipment.externalId!);
    } catch (error) {
      throw providerFailure(error, "schedule the pickup");
    }
    await this.runner.$transaction((tx) =>
      applyShipmentUpdate(
        tx,
        shipmentId,
        {
          status: ShipmentStatus.PICKUP_SCHEDULED,
          pickupScheduledAt: parseEtd(pickup.scheduledDate),
          meta: { pickupToken: pickup.tokenNumber },
          activity: { type: ActivityType.SHIPMENT_PICKUP_SCHEDULED, title: `Pickup scheduled for order ${shipment.order.orderNumber}` },
        },
        { source: ActivitySource.USER, actor: user, now: this.now() },
      ),
    );
    return this.reload(shipmentId);
  }

  async generateLabel(user: AuthUser, shipmentId: string): Promise<ShipmentResult> {
    const config = this.config();
    const shipment = await this.runner.$transaction((tx) => this.loadShipment(tx, user, shipmentId));
    if (shipment.labelUrl) return toResult(shipment);
    if (!shipment.trackingNumber) throw new ApiError("Assign an AWB before generating a label", STATUS_CODES.CONFLICT);

    let labelUrl: string;
    try {
      labelUrl = await this.api(config).generateLabel(shipment.externalId!);
    } catch (error) {
      throw providerFailure(error, "generate the label");
    }
    await this.runner.$transaction((tx) =>
      applyShipmentUpdate(tx, shipmentId, { labelUrl, activity: { type: ActivityType.SHIPMENT_LABEL_GENERATED, title: `Shipping label generated for order ${shipment.order.orderNumber}` } }, { source: ActivitySource.USER, actor: user, now: this.now() }),
    );
    return this.reload(shipmentId);
  }

  /** Reads tracking from Shiprocket and applies it. The webhook does the same automatically. */
  async refreshTracking(user: AuthUser, shipmentId: string): Promise<ShipmentResult> {
    const config = this.config();
    const shipment = await this.runner.$transaction((tx) => this.loadShipment(tx, user, shipmentId));
    if (!shipment.trackingNumber) throw new ApiError("This shipment has no AWB yet, so there is nothing to track", STATUS_CODES.CONFLICT);

    let tracking;
    try {
      tracking = await this.api(config).track(shipment.trackingNumber);
    } catch (error) {
      throw providerFailure(error, "read tracking");
    }
    if (!tracking) throw new ApiError("Shiprocket has no tracking information for this AWB yet", STATUS_CODES.NOT_FOUND);

    await this.runner.$transaction((tx) =>
      applyShipmentUpdate(
        tx,
        shipmentId,
        { status: mapShiprocketStatus(tracking.currentStatus), providerStatus: tracking.currentStatus, courier: tracking.courierName, trackingUrl: tracking.trackUrl, expectedDeliveryAt: parseEtd(tracking.etd) },
        { source: ActivitySource.USER, actor: user, now: this.now() },
      ),
    );
    return this.reload(shipmentId);
  }

  // ---------------------------------------------------------------- centralized listing/tracking

  /**
   * Every shipment the CRM has created directly through Shiprocket, across all orders - the "Shiprocket" sidebar page.
   * Shopify-derived shipment rows never appear here; this only ever reads rows this CRM itself created (externalSource
   * SHIPROCKET), same as every other Shiprocket-specific read in this service.
   */
  async listShipments(user: AuthUser, query: ListShipmentsQuery): Promise<ListShipmentsResult> {
    const { totalItems, rows, statusCounts } = await this.runner.$transaction(async (tx) => {
      const leadScope = await getLeadScope(user, tx);
      const where = buildShipmentListWhere(query, leadScope);

      const [totalItems, rows, statusCounts] = await Promise.all([
        tx.shipment.count({ where }),
        tx.shipment.findMany({
          where,
          select: LIST_SELECT,
          // id breaks ties so pages never repeat or skip rows created in the same instant.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        // Counted over the same filters but without pagination, so the summary cards describe the whole filtered set,
        // not just the current page - one grouped COUNT, not a second full table scan.
        tx.shipment.groupBy({ by: ["status"], where, _count: { _all: true } }),
      ]);
      return { totalItems, rows, statusCounts };
    });

    const items = rows.map(mapShipmentListRow);
    // Fetched after the DB transaction has closed, so an external HTTP round trip never holds a DB
    // connection open. One batched, deduplicated, cached call for the whole page - never one per row.
    // A row with no AWB yet is simply left without `liveTracking` (see getLiveTrackingBatch/getLiveTracking).
    const awbs = items.map((i) => i.awb).filter((awb): awb is string => Boolean(awb));
    if (awbs.length > 0) {
      const live = await getLiveTrackingBatch(awbs);
      for (const item of items) {
        if (item.awb) item.liveTracking = live.get(item.awb);
      }
    }

    return {
      items,
      summary: buildShipmentSummary(statusCounts),
      pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) },
    };
  }

  async getShipmentDetail(user: AuthUser, shipmentId: string): Promise<ShipmentDetailResult> {
    const shipment = await this.runner.$transaction(async (tx) => {
      const leadScope = await getLeadScope(user, tx);
      return tx.shipment.findFirst({ where: scopedShipmentWhere(shipmentId, leadScope), select: DETAIL_SELECT });
    });
    // Out-of-scope shipments look the same as missing ones so ids can't be probed - same rule orders.service.ts uses.
    if (!shipment) throw new ApiError("Shipment not found", STATUS_CODES.NOT_FOUND);
    const detail = mapShipmentDetailRow(shipment);
    if (detail.awb) {
      const live = await getLiveTrackingBatch([detail.awb]);
      detail.liveTracking = live.get(detail.awb);
    }
    return detail;
  }

  /** Courier names actually seen on this user's own Shiprocket shipments, for the courier filter dropdown. */
  async getFilterOptions(user: AuthUser): Promise<ShipmentFilterOptions> {
    const rows = await this.runner.$transaction(async (tx) => {
      const leadScope = await getLeadScope(user, tx);
      const where: Prisma.ShipmentWhereInput = { ...SHIPROCKET_SOURCE, courier: { not: null }, ...(Object.keys(leadScope).length > 0 ? { order: { lead: leadScope } } : {}) };
      return tx.shipment.findMany({ where, distinct: ["courier"], select: { courier: true }, orderBy: { courier: "asc" } });
    });
    return { couriers: rows.map((r) => r.courier!).filter(Boolean) };
  }
}

export default ShiprocketShipmentsService;
