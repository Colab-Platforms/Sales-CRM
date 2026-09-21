import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import { getLeadScope } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, OrderStatus, ShipmentStatus, type PaymentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { computePaymentBreakdown, fullName, scopedOrderWhere } from "../orders/orders.filters.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { advisoryLock, asRecord, ProviderHttpError, toTenDigitMobile, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { applyShipmentUpdate, shipmentOrderLockKey, SHIPMENT_REFERENCE_TYPE } from "./shiprocket.apply.js";
import { ShiprocketClient, type CourierOption, type CreateOrderRequest, type CreatedOrder } from "./shiprocket.client.js";
import { isShiprocketEnabled, loadShiprocketConfig, ShiprocketConfigError, type ShiprocketConfig } from "./shiprocket.config.js";
import { mapShiprocketStatus, parseEtd } from "./shiprocket.events.js";

// Creates and drives Shiprocket shipments for an existing CRM order (Shopify-sourced or otherwise). The Shipment row is
// tagged externalSource SHIPROCKET, which is what keeps Shopify sync from ever reading, overwriting or deleting it; the
// Shopify-derived shipment for the same parcel (if any) stays a separate row and is linked by AWB when displayed.

export interface ShiprocketApi {
  createOrder(request: CreateOrderRequest): Promise<CreatedOrder>;
  getCouriers(shiprocketOrderId: string): Promise<CourierOption[]>;
  assignAwb(shipmentId: string, courierId: number): Promise<{ awb: string; courierName: string | null; courierCompanyId: number | null }>;
  generatePickup(shipmentId: string): Promise<{ scheduledDate: string | null; tokenNumber: string | null }>;
  generateLabel(shipmentId: string): Promise<string>;
  track(awb: string): Promise<{ awb: string; currentStatus: string | null; trackUrl: string | null; etd: string | null; courierName: string | null } | null>;
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
  /** Only on creation: how Shiprocket was told to collect payment. */
  paymentMethod?: "Prepaid" | "COD";
  collectOnDelivery?: string;
}

export interface ShipmentServiceDeps {
  config?: () => ShiprocketConfig;
  client?: (config: ShiprocketConfig) => ShiprocketApi;
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
  externalSource: true,
  externalId: true,
  metadata: true,
  order: { select: { id: true, leadId: true, orderNumber: true } },
} satisfies Prisma.ShipmentSelect;

type ShipmentRow = Prisma.ShipmentGetPayload<{ select: typeof SHIPMENT_SELECT }>;

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

interface AddressShape {
  name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
  phone?: string | null;
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
  const address = asRecord(order.shippingAddress) as AddressShape;
  const missing: string[] = [];
  const name = (address.name ?? "").trim() || fullName(order.lead.firstName, order.lead.lastName);
  if (!(address.address1 ?? "").trim()) missing.push("shipping address line");
  if (!(address.city ?? "").trim()) missing.push("city");
  if (!(address.province ?? "").trim()) missing.push("state");
  const pincode = (address.zip ?? "").trim();
  if (!/^\d{6}$/.test(pincode)) missing.push("6-digit pincode");
  const phone = toTenDigitMobile(address.phone) ?? toTenDigitMobile(order.lead.normalizedMobile) ?? toTenDigitMobile(order.lead.mobile);
  if (!phone) missing.push("10-digit phone number");
  if (order.items.length === 0) missing.push("order items");
  if (missing.length > 0) throw new ApiError(`This order can not be shipped yet - missing: ${missing.join(", ")}`, STATUS_CODES.BAD_REQUEST);

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
    billing_address: address.address1!.trim(),
    ...(address.address2?.trim() ? { billing_address_2: address.address2.trim() } : {}),
    billing_city: address.city!.trim(),
    billing_pincode: pincode,
    billing_state: address.province!.trim(),
    billing_country: (address.country ?? "").trim() || "India",
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

  async createShipment(user: AuthUser, orderId: string, input: ShipmentInput): Promise<ShipmentResult> {
    const config = this.config();
    const prepared = await this.runner.$transaction((tx) => this.prepare(tx, user, orderId, input, config));

    let created: CreatedOrder;
    try {
      created = await this.api(config).createOrder(prepared.request);
    } catch (error) {
      await this.recordCreationFailure(prepared.shipmentId, error);
      throw providerFailure(error, "create the shipment");
    }

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
          metadata: { shiprocket: { created: true, channelOrderId: prepared.request.order_id } },
        },
      });
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
  private async prepare(tx: Db, user: AuthUser, orderId: string, input: ShipmentInput, config: ShiprocketConfig) {
    await advisoryLock(tx, shipmentOrderLockKey(orderId));
    const scope = await getLeadScope(user, tx);
    const order = await tx.order.findFirst({
      where: scopedOrderWhere(orderId, scope),
      select: {
        id: true,
        orderNumber: true,
        status: true,
        placedAt: true,
        createdAt: true,
        currency: true,
        totalAmount: true,
        discountAmount: true,
        shippingAmount: true,
        shippingAddress: true,
        lead: { select: { id: true, firstName: true, lastName: true, mobile: true, normalizedMobile: true, email: true } },
        items: { select: { productNameSnapshot: true, variantNameSnapshot: true, skuSnapshot: true, quantity: true, unitPrice: true, discountAmount: true, taxAmount: true } },
        payments: { select: { status: true, amount: true, refundedAmount: true } },
        shipments: { where: { externalSource: "SHIPROCKET" }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, metadata: true, externalId: true, createdAt: true } },
      },
    });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    if (BLOCKED_ORDER_STATUSES.has(order.status)) throw new ApiError(`A shipment can not be created for a ${order.status.toLowerCase()} order`, STATUS_CODES.BAD_REQUEST);

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

    const shipmentId = randomUUID();
    const channelOrderId = `${order.orderNumber}-${shipmentId.slice(0, 8)}`.slice(0, 50);
    const { request, collectCents } = buildShiprocketOrder(order, input, config.pickupLocation, channelOrderId);

    await tx.shipment.create({
      data: {
        id: shipmentId,
        orderId: order.id,
        status: ShipmentStatus.CREATED,
        externalSource: "SHIPROCKET",
        externalId: `pending:${shipmentId}`,
        channelOrderId,
        metadata: { shiprocket: { creating: true } },
      },
    });
    return { shipmentId, request, collectCents, orderNumber: order.orderNumber, leadId: order.lead.id };
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
}

export default ShiprocketShipmentsService;
