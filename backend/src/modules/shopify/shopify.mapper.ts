import { OrderSource, OrderStatus, PaymentMethod, PaymentStatus, ProductStatus } from "../../../generated/prisma/enums.js";
import type { NormalizedProduct, NormalizedShopifyCustomer } from "./shopify.catalog.js";
import { fromCents, gidToId, sumCents, toCents } from "./shopify.money.js";
import type { NormalizedFulfillment, NormalizedOrder, NormalizedTransaction } from "./shopify.orders.js";

// The one place that turns Shopify data into CRM shapes. Pure functions only: no database, no network.

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

const KNOWN_FINANCIAL = new Set(["PENDING", "AUTHORIZED", "PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED", "EXPIRED"]);
const KNOWN_FULFILLMENT = new Set([
  "UNFULFILLED", "PARTIALLY_FULFILLED", "FULFILLED", "RESTOCKED", "PENDING_FULFILLMENT", "OPEN", "IN_PROGRESS", "ON_HOLD", "SCHEDULED", "REQUEST_DECLINED",
]);

// Delivery progress of a shipment, by Shopify's fulfillment display status. Unlisted values count as "shipped".
const DELIVERED = new Set(["DELIVERED"]);
const OUT_FOR_DELIVERY = new Set(["OUT_FOR_DELIVERY", "ATTEMPTED_DELIVERY"]);
const CLOSED_FULFILLMENT = new Set(["CANCELLED", "ERROR", "FAILURE"]);

// This store's shipping integration (Shiprocket) tags an order when the parcel has come back to the seller.
const RTO_DELIVERED_TAG = /\brto delivered\b/i;
const COD_TAG = /\bcash on delivery\b|\bcod\b/i;
const PREPAID_TAG = /\bprepaid\b/i;
const COD_GATEWAY = /\bcash on delivery\b|\bcod\b/i;

export interface StatusInput {
  cancelledAt: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  returnStatus: string | null;
  fulfillments: Pick<NormalizedFulfillment, "status" | "displayStatus">[];
  tags: string[];
  isCod: boolean;
}

export interface StatusResult {
  status: OrderStatus;
  /** Shopify values the mapping does not recognise. They are kept in the order metadata, never dropped. */
  unmapped: string[];
}

export function mapOrderStatus(input: StatusInput): StatusResult {
  const financial = input.financialStatus ?? "";
  const fulfillment = input.fulfillmentStatus ?? "";
  const unmapped: string[] = [];
  if (financial && !KNOWN_FINANCIAL.has(financial)) unmapped.push(`financialStatus:${financial}`);
  if (fulfillment && !KNOWN_FULFILLMENT.has(fulfillment)) unmapped.push(`fulfillmentStatus:${fulfillment}`);

  const done = (status: OrderStatus): StatusResult => ({ status, unmapped });

  if (input.cancelledAt || financial === "VOIDED" || financial === "EXPIRED") return done(OrderStatus.CANCELLED);
  if (input.returnStatus === "RETURNED" || input.returnStatus === "INSPECTION_COMPLETE" || fulfillment === "RESTOCKED") {
    return done(OrderStatus.RETURNED);
  }
  if (financial === "REFUNDED") return done(OrderStatus.REFUNDED);

  const shipments = input.fulfillments.filter((f) => !CLOSED_FULFILLMENT.has(f.status));
  if (fulfillment === "FULFILLED") {
    if (input.tags.some((t) => RTO_DELIVERED_TAG.test(t))) return done(OrderStatus.RETURNED);
    if (shipments.length > 0 && shipments.every((f) => DELIVERED.has(f.displayStatus ?? ""))) return done(OrderStatus.DELIVERED);
    if (shipments.length > 0 && shipments.every((f) => DELIVERED.has(f.displayStatus ?? "") || OUT_FOR_DELIVERY.has(f.displayStatus ?? ""))) {
      return done(OrderStatus.OUT_FOR_DELIVERY);
    }
    return done(OrderStatus.SHIPPED);
  }
  if (["PARTIALLY_FULFILLED", "IN_PROGRESS", "PENDING_FULFILLMENT", "ON_HOLD"].includes(fulfillment)) return done(OrderStatus.PROCESSING);

  // Not shipped yet: confirmed once paid, or accepted for cash on delivery; otherwise still awaiting payment.
  const paid = ["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED"].includes(financial);
  return done(paid || input.isCod ? OrderStatus.CONFIRMED : OrderStatus.PENDING_PAYMENT);
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

export interface MappedPayment {
  externalId: string;
  status: PaymentStatus;
  method: PaymentMethod | null;
  amount: string;
  currency: string;
  provider: string | null;
  providerPaymentId: string | null;
  transactionReference: string | null;
  paidAt: Date | null;
  failedAt: Date | null;
  refundedAt: Date | null;
  failureReason: string | null;
  refundedAmount: string | null;
}

export const isCodGateway = (gateway: string | null | undefined): boolean => !!gateway && COD_GATEWAY.test(gateway);

export function isCodOrder(order: Pick<NormalizedOrder, "paymentGateways" | "transactions" | "tags">): boolean {
  return (
    order.paymentGateways.some(isCodGateway) ||
    order.transactions.some((t) => isCodGateway(t.gateway)) ||
    order.tags.some((t) => COD_TAG.test(t))
  );
}

const SALE_KINDS = new Set(["SALE", "AUTHORIZATION", "EMV_AUTHORIZATION"]);
const date = (iso: string | null | undefined) => (iso ? new Date(iso) : null);

/** COD, or "some other method" when the order clearly was paid up front, or unknown (null). */
function methodFor(gateway: string | null, order: Pick<NormalizedOrder, "tags" | "paymentGateways">, cod: boolean): PaymentMethod | null {
  if (cod || isCodGateway(gateway)) return PaymentMethod.COD;
  if (gateway || order.paymentGateways.length > 0 || order.tags.some((t) => PREPAID_TAG.test(t))) return PaymentMethod.OTHER;
  return null;
}

function rootStatus(tx: NormalizedTransaction, captured: boolean, voided: boolean): PaymentStatus {
  if (voided) return PaymentStatus.FAILED;
  if (tx.status === "FAILURE" || tx.status === "ERROR") return PaymentStatus.FAILED;
  if (tx.status === "SUCCESS") return tx.kind === "SALE" || captured ? PaymentStatus.SUCCESS : PaymentStatus.PROCESSING; // authorized, not yet captured
  if (tx.status === "AWAITING_RESPONSE") return PaymentStatus.PROCESSING;
  return PaymentStatus.PENDING;
}

export function mapPayments(order: NormalizedOrder): MappedPayment[] {
  const cod = isCodOrder(order);
  const orderId = gidToId(order.id);
  const currency = order.currency;
  const roots = order.transactions.filter((t) => SALE_KINDS.has(t.kind));

  if (roots.length === 0) return synthesizePayment(order, cod, orderId);

  const successfulRefunds = order.transactions.filter((t) => t.kind === "REFUND" && t.status === "SUCCESS");
  const firstPaid = roots.find((t) => t.status === "SUCCESS" && (t.kind === "SALE" || hasCapture(order, t.id)));

  return roots.map((root) => {
    const capture = order.transactions.find((t) => t.kind === "CAPTURE" && t.status === "SUCCESS" && t.parentId === root.id);
    const voided = order.transactions.some((t) => t.kind === "VOID" && t.status === "SUCCESS" && t.parentId === root.id);
    let status = rootStatus(root, !!capture, voided);
    const amount = capture?.amount ?? root.amount ?? "0";

    // Refunds belong to the payment they name; a refund with no known parent goes to the first paid payment.
    const refunds = successfulRefunds.filter((r) => (r.parentId ? r.parentId === root.id : firstPaid?.id === root.id));
    const refundedCents = sumCents(refunds.map((r) => r.amount));
    let refundedAt: Date | null = null;
    if (refundedCents > 0 && status === PaymentStatus.SUCCESS) {
      status = refundedCents >= toCents(amount) ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
      refundedAt = date(refunds.map((r) => r.processedAt).filter(Boolean).sort().at(-1) ?? null);
    }

    return {
      externalId: gidToId(root.id),
      status,
      method: methodFor(root.gateway, order, cod),
      amount,
      currency,
      provider: root.gateway,
      providerPaymentId: root.paymentId,
      // Prefer the gateway's own reference; fall back to Shopify's transaction id so one is always present.
      transactionReference: root.paymentId ?? gidToId(root.id),
      paidAt: status === PaymentStatus.SUCCESS || refundedAt ? date(capture?.processedAt ?? root.processedAt) : null,
      failedAt: status === PaymentStatus.FAILED ? date(root.processedAt) : null,
      refundedAt,
      failureReason: status === PaymentStatus.FAILED ? (voided ? "Authorization voided" : (root.errorCode ?? "Payment failed")) : null,
      refundedAmount: refundedCents > 0 ? fromCents(refundedCents) : null,
    };
  });
}

const hasCapture = (order: NormalizedOrder, rootId: string) =>
  order.transactions.some((t) => t.kind === "CAPTURE" && t.status === "SUCCESS" && t.parentId === rootId);

// Orders with no gateway transaction (typical for cash on delivery, or a payment not yet started) still need a
// payment record so payment status and COD/prepaid are visible. It is replaced once a real transaction appears.
function synthesizePayment(order: NormalizedOrder, cod: boolean, orderId: string): MappedPayment[] {
  const financial = order.financialStatus ?? "";
  const total = order.amounts.total ?? "0";
  if (toCents(total) <= 0) return [];

  const refundedCents = toCents(order.amounts.refunded);
  const status: PaymentStatus =
    financial === "PAID" ? PaymentStatus.SUCCESS
    : financial === "REFUNDED" ? PaymentStatus.REFUNDED
    : financial === "PARTIALLY_REFUNDED" ? PaymentStatus.PARTIALLY_REFUNDED
    : financial === "VOIDED" || financial === "EXPIRED" ? PaymentStatus.FAILED
    : PaymentStatus.PENDING;
  const settledAt = date(order.processedAt ?? order.updatedAt);

  return [
    {
      externalId: `synthetic-${orderId}`,
      status,
      method: methodFor(null, order, cod),
      amount: total,
      currency: order.currency,
      provider: order.paymentGateways[0] ?? null,
      providerPaymentId: null,
      transactionReference: null,
      paidAt: status === PaymentStatus.SUCCESS ? settledAt : null,
      failedAt: status === PaymentStatus.FAILED ? settledAt : null,
      refundedAt: refundedCents > 0 ? settledAt : null,
      failureReason: status === PaymentStatus.FAILED ? `Shopify payment status ${financial}` : null,
      refundedAmount: refundedCents > 0 ? fromCents(refundedCents) : null,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------------------------

export interface MappedItem {
  externalLineId: string;
  productExternalId: string | null;
  variantExternalId: string | null;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: string;
  discountAmount: string;
  taxAmount: string;
  totalPrice: string;
}

export interface MappedLeadIdentity {
  externalId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
}

export interface MappedOrder {
  externalId: string;
  externalNumber: string;
  orderNumber: string;
  source: typeof OrderSource.SHOPIFY;
  status: OrderStatus;
  currency: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  shippingAmount: string;
  totalAmount: string;
  discountReason: string | null;
  createdAt: Date;
  placedAt: Date;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  externalUpdatedAt: Date;
  shippingAddress: Record<string, string | null> | null;
  shippingPincode: string | null;
  metadata: Record<string, unknown>;
  items: MappedItem[];
  payments: MappedPayment[];
  identity: MappedLeadIdentity;
  /** Something the mapping could not fully explain (unrecognised status, totals that do not add up). */
  warnings: string[];
}

const CONFIRMED_OR_LATER = new Set<OrderStatus>([
  OrderStatus.CONFIRMED, OrderStatus.PROCESSING, OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED, OrderStatus.RETURNED, OrderStatus.REFUNDED,
]);

export function mapOrder(order: NormalizedOrder): MappedOrder {
  const warnings: string[] = [];
  const cod = isCodOrder(order);
  const { status, unmapped } = mapOrderStatus({
    cancelledAt: order.cancelledAt,
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    returnStatus: order.returnStatus,
    fulfillments: order.fulfillments,
    tags: order.tags,
    isCod: cod,
  });
  if (unmapped.length > 0) warnings.push(`Unrecognised Shopify status kept in metadata only: ${unmapped.join(", ")}`);
  if (order.itemsTruncated) warnings.push("Order has more line items than were fetched");

  // Shopify's "subtotal" is after discounts, so the gross is rebuilt from the line items to fit our subtotal - discount model.
  const items: MappedItem[] = order.items.map((item) => {
    const unit = toCents(item.unitPrice);
    const discount = sumCents(item.discounts);
    const tax = sumCents(item.taxes);
    const gross = unit * item.quantity;
    return {
      externalLineId: gidToId(item.id),
      productExternalId: item.productId ? gidToId(item.productId) : null,
      variantExternalId: item.variantId ? gidToId(item.variantId) : null,
      productName: item.title,
      variantName: item.variantTitle && item.variantTitle !== "Default Title" ? item.variantTitle : null,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: fromCents(unit),
      discountAmount: fromCents(discount),
      taxAmount: fromCents(tax),
      totalPrice: fromCents(gross - discount + (order.taxesIncluded ? 0 : tax)),
    };
  });

  const gross = order.items.reduce((sum, i) => sum + toCents(i.unitPrice) * i.quantity, 0);
  const discount = toCents(order.amounts.discount);
  const tax = toCents(order.amounts.tax);
  const shipping = toCents(order.amounts.shipping);
  const total = toCents(order.amounts.total);
  const expected = gross - discount + shipping + (order.taxesIncluded ? 0 : tax);
  let reconciliation: Record<string, string> | undefined;
  if (expected !== total) {
    reconciliation = { expected: fromCents(expected), actual: fromCents(total), difference: fromCents(total - expected) };
    warnings.push(`Totals do not reconcile: items give ${fromCents(expected)}, Shopify says ${fromCents(total)}`);
  }

  const payments = mapPayments(order);
  const placedAt = new Date(order.processedAt ?? order.createdAt);
  const address = order.shippingAddress;

  return {
    externalId: gidToId(order.id),
    externalNumber: order.name,
    orderNumber: `SHP-${order.name.replace(/^#/, "")}`.slice(0, 50),
    source: OrderSource.SHOPIFY,
    status,
    currency: order.currency,
    subtotal: fromCents(gross),
    discountAmount: fromCents(discount),
    taxAmount: fromCents(tax),
    shippingAmount: fromCents(shipping),
    totalAmount: fromCents(total),
    discountReason: order.discountCodes.length > 0 ? order.discountCodes.join(", ").slice(0, 500) : null,
    createdAt: new Date(order.createdAt),
    placedAt,
    confirmedAt: CONFIRMED_OR_LATER.has(status) ? placedAt : null,
    cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
    cancelReason: order.cancelReason,
    externalUpdatedAt: new Date(order.updatedAt),
    shippingAddress: address && {
      name: address.name,
      address1: address.address1,
      address2: address.address2,
      city: address.city,
      province: address.province,
      provinceCode: address.provinceCode,
      zip: address.zip,
      country: address.country,
      countryCode: address.countryCode,
      phone: address.phone,
    },
    shippingPincode: address?.zip?.slice(0, 12) ?? null,
    metadata: {
      shopify: {
        financialStatus: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        returnStatus: order.returnStatus,
        gateways: order.paymentGateways,
        tags: order.tags,
        discountCodes: order.discountCodes,
        taxesIncluded: order.taxesIncluded,
        refunded: order.amounts.refunded,
        transactions: order.transactions.map((t) => ({ id: gidToId(t.id), kind: t.kind, status: t.status, gateway: t.gateway })),
        fulfillments: order.fulfillments.map((f) => ({
          id: gidToId(f.id), status: f.status, displayStatus: f.displayStatus, deliveredAt: f.deliveredAt,
          trackingCompany: f.trackingCompany, trackingNumber: f.trackingNumber, trackingUrl: f.trackingUrl,
        })),
      },
      paymentMode: cod ? "COD" : payments.some((p) => p.method) ? "PREPAID" : null,
      ...(unmapped.length > 0 ? { unmappedStatuses: unmapped } : {}),
      ...(reconciliation ? { reconciliation } : {}),
    },
    items,
    payments,
    identity: {
      externalId: order.customer.id ? gidToId(order.customer.id) : null,
      firstName: order.customer.firstName,
      lastName: order.customer.lastName,
      email: order.customer.email,
      phone: order.customer.phone,
      location: [address?.city, address?.province].filter(Boolean).join(", ") || null,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Product and customer
// ---------------------------------------------------------------------------------------------

export interface MappedVariant {
  externalId: string;
  name: string;
  sku: string | null;
  price: string | null;
  status: ProductStatus;
  externalUpdatedAt: Date;
}

export interface MappedProduct {
  externalId: string;
  name: string;
  description: string | null;
  status: ProductStatus;
  basePrice: string | null;
  externalUpdatedAt: Date;
  variants: MappedVariant[];
}

export function mapProduct(product: NormalizedProduct): MappedProduct {
  const status = product.status === "ACTIVE" ? ProductStatus.ACTIVE : ProductStatus.INACTIVE;
  const prices = product.variants.map((v) => toCents(v.price)).filter((c) => c > 0);

  return {
    externalId: gidToId(product.id),
    name: product.title.slice(0, 200),
    description: product.description,
    status,
    basePrice: prices.length > 0 ? fromCents(Math.min(...prices)) : null,
    externalUpdatedAt: new Date(product.updatedAt),
    variants: product.variants.map((v) => ({
      externalId: gidToId(v.id),
      name: v.title.slice(0, 150),
      sku: v.sku,
      price: v.price ? fromCents(toCents(v.price)) : null,
      status,
      externalUpdatedAt: new Date(v.updatedAt ?? product.updatedAt),
    })),
  };
}

export function mapCustomer(customer: NormalizedShopifyCustomer): MappedLeadIdentity & { externalUpdatedAt: Date } {
  return {
    externalId: gidToId(customer.id),
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone,
    location: [customer.city, customer.province].filter(Boolean).join(", ") || null,
    externalUpdatedAt: new Date(customer.updatedAt),
  };
}
