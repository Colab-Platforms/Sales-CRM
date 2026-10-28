import { OrderStatus, PaymentStatus } from "../../../generated/prisma/enums.js";
import { fulfilmentOf, type FulfilmentFilter, type Metric } from "./orders.dashboard.service.js";
import { bucketsFor, bucketStart, type Interval } from "./orders.dashboard.insights.js";
import { LIVE_ORDER_ID_PREFIX } from "./orders.live.types.js";
import type { LiveOrder } from "./orders.dashboard.live.source.js";

// The Website Orders figures worked out from live Shopify orders. The definitions are the SAME as the database-backed dashboard's (orders.dashboard.service.ts metricWhere), applied to the Shopify order's
// status / payment as the Shopify sync would derive them - so a card, the chart and the clicked list all come from one filter and one list.
// Money is added in whole cents (never floating point). Only INR orders are valued; the source adds a warning when another currency appears.

const FULFILLED_STATUSES: OrderStatus[] = [OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED];
const inInr = (o: LiveOrder) => o.currency === "INR";

/** Does this order belong to the card? (The card's number and the rows behind it both come from here.) */
export function matchesMetric(o: LiveOrder, metric: Metric): boolean {
  switch (metric) {
    case "TOTAL":
      return true;
    case "VALUE": // what the value card adds up: every order except cancelled ones
      return o.status !== OrderStatus.CANCELLED;
    case "COD":
      return o.paymentMode === "COD";
    case "PREPAID":
      return o.paymentMode === "PREPAID";
    case "PAID":
      return o.paymentStatus === PaymentStatus.SUCCESS;
    case "PENDING":
      return o.paymentStatus === PaymentStatus.PENDING || o.paymentStatus === PaymentStatus.PROCESSING || o.status === OrderStatus.PENDING_PAYMENT;
    case "CANCELLED":
      return o.status === OrderStatus.CANCELLED;
    case "FULFILLED":
      return FULFILLED_STATUSES.includes(o.status);
  }
}

const rupees = (cents: number) => Math.round(cents) / 100;

export function summarize(orders: LiveOrder[]) {
  const count = (m: Metric) => orders.filter((o) => matchesMetric(o, m)).length;
  const cents = (m: Metric) => orders.filter((o) => matchesMetric(o, m) && inInr(o)).reduce((s, o) => s + o.totalCents, 0);
  return {
    totalOrders: orders.length,
    totalValue: rupees(cents("VALUE")),
    cod: count("COD"),
    prepaid: count("PREPAID"),
    paid: count("PAID"),
    pendingPayment: count("PENDING"),
    cancelled: count("CANCELLED"),
    cancelledValue: rupees(cents("CANCELLED")),
    fulfilled: count("FULFILLED"),
    ...revenueSplit(orders),
  };
}

/**
 * The three money cards the Website dashboard also shows - the SAME rules as the database-backed dashboard (orders.dashboard.service.ts):
 *   codRevenue / prepaidRevenue = value of the COD / prepaid orders that are not cancelled;
 *   collected = money received on the selected orders: a paid order counts in full, a partially refunded one net of what was refunded (the Reports' own definition of "paid").
 * They were missing from this summary, so the cards read `undefined` and rendered "NaN". The figures that already existed above are untouched.
 */
export function revenueSplit(orders: LiveOrder[]): { codRevenue: number; prepaidRevenue: number; collected: number } {
  const live = orders.filter(inInr);
  const sum = (pick: (o: LiveOrder) => number) => live.reduce((s, o) => s + pick(o), 0);
  const notCancelled = (o: LiveOrder) => o.status !== OrderStatus.CANCELLED;
  return {
    codRevenue: rupees(sum((o) => (o.paymentMode === "COD" && notCancelled(o) ? o.totalCents : 0))),
    prepaidRevenue: rupees(sum((o) => (o.paymentMode === "PREPAID" && notCancelled(o) ? o.totalCents : 0))),
    collected: rupees(sum((o) => (o.paymentStatus === PaymentStatus.SUCCESS ? o.totalCents : o.paymentStatus === PaymentStatus.PARTIALLY_REFUNDED ? Math.max(0, o.totalCents - o.refundedCents) : 0))),
  };
}

export interface ListFilters {
  metric?: Metric;
  search?: string;
  paymentStatus?: string;
  fulfilment?: FulfilmentFilter;
}

const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

/** The orders behind a card, narrowed by the search box and the payment / fulfilment filters (newest first, as fetched). */
export function filterOrders(orders: LiveOrder[], f: ListFilters): LiveOrder[] {
  const q = f.search?.trim().toLowerCase() ?? "";
  const qDigits = digits(q);
  return orders.filter((o) => {
    if (f.metric && !matchesMetric(o, f.metric)) return false;
    if (f.paymentStatus && (f.paymentStatus === "NO_PAYMENT" ? o.paymentStatus !== null : o.paymentStatus !== f.paymentStatus)) return false;
    if (f.fulfilment && fulfilmentOf(o.status) !== f.fulfilment) return false;
    if (q) {
      const hit = o.name.toLowerCase().includes(q) || (o.customerName ?? "").toLowerCase().includes(q) || (qDigits.length >= 3 && digits(o.phone).includes(qDigits));
      if (!hit) return false;
    }
    return true;
  });
}

/** One dashboard row (the same shape as the database-backed rows, so the table renders either). */
export const toRow = (o: LiveOrder) => ({
  id: `${LIVE_ORDER_ID_PREFIX}${o.externalId}`,
  orderId: o.name,
  orderNumber: o.name,
  orderDate: o.createdAt,
  customerName: o.customerName ?? "",
  phone: o.phone,
  totalAmount: rupees(o.totalCents),
  currency: o.currency,
  paymentMethod: o.paymentMode,
  paymentStatus: o.paymentStatus,
  orderStatus: o.status,
  fulfilmentStatus: fulfilmentOf(o.status),
  source: "SHOPIFY" as const,
  section: "WEBSITE" as const,
  telecallerName: null,
});

/** Orders & revenue per bucket (daily / weekly Monday-start / monthly) in the business timezone: bars = orders placed (cancelled included), line = value excluding cancelled - exactly the two cards. */
export function chartBuckets(orders: LiveOrder[], range: { from: string; to: string }, interval: Interval) {
  const totals = new Map<string, { orders: number; cents: number }>();
  for (const o of orders) {
    const key = bucketStart(o.localDate, interval);
    const t = totals.get(key) ?? { orders: 0, cents: 0 };
    t.orders++;
    if (matchesMetric(o, "VALUE") && inInr(o)) t.cents += o.totalCents;
    totals.set(key, t);
  }
  return bucketsFor(range, interval).map((b) => {
    const t = totals.get(b.key);
    return { key: b.key, from: b.from, to: b.to, available: true, partial: false, orders: t?.orders ?? 0, revenue: rupees(t?.cents ?? 0) };
  });
}
