import { computePaymentBreakdown, derivePaymentMode, derivePaymentStatus } from "../orders/orders.filters.js";
import { istDay } from "./hrms.range.js";

// THE CALCULATIONS behind the HRMS reporting API. Pure: facts in, aggregates out, no database, no clock. Money is carried in whole paise and converted to rupees once on the way out, so totals never drift.
// The inputs are deliberately PRIVACY-SHAPED: an order fact has no customer, no phone, no order number - only what is needed to add things up. Nothing in this file can leak a customer, because it is never given one.
//
// BUSINESS DATE per metric (always an Asia/Kolkata calendar day):
//   orders / sales   order.at = confirmedAt ?? placedAt ?? createdAt   (the Reports' own "when did the sale happen")
//   payments         captured: paidAt   refunded: refundedAt   failed: failedAt (else createdAt)   pending: createdAt
//   leads            createdAt
// Revenue, cancelled / refunded orders and money actually collected are three separate things and are never mixed: a COD order is revenue when it is sold, but is COLLECTED only once a payment row is SUCCESS.

const FULFILLED = new Set(["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]);
export const ORDER_STATUSES = ["PENDING_PAYMENT", "CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "RETURNED", "REFUNDED"] as const;
const PAYMENT_STATUSES = ["SUCCESS", "PENDING", "PROCESSING", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"] as const;
const COLLECTED_STATUSES = new Set(["SUCCESS", "PARTIALLY_REFUNDED", "REFUNDED"]);

export const rupees = (paise: number): number => Math.round(paise) / 100;
export const toPaise = (v: { toString(): string } | null | undefined): number => (v === null || v === undefined ? 0 : Math.round(Number(v.toString()) * 100));
export const ratio = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 10_000) / 100 : null);
const inRange = (at: Date | null | undefined, start: Date, end: Date): boolean => Boolean(at && at >= start && at < end);

// ----------------------------------------------------------------------------------------------- orders

export interface PayFact {
  method: string | null;
  status: string;
  amountCents: number;
  refundedCents: number;
}
export interface ItemFact {
  /** The CRM product (variants roll up to it); null for a custom (free-text) line. */
  productId: string | null;
  name: string;
  sku: string | null;
  units: number;
  totalCents: number;
  custom: boolean;
}
export interface OrderFact {
  at: Date;
  status: string;
  source: string;
  totalCents: number;
  discountCents: number;
  couponId: string | null;
  couponCode: string | null;
  /** The CRM source of the customer's lead (a marketing channel), or null. */
  leadSourceId: string | null;
  payments: PayFact[];
  items: ItemFact[];
}

export type OrderCategory = "SOLD" | "REFUNDED_IN_FULL" | "CANCELLED" | "RETURNED" | "PENDING_PAYMENT";
export interface DerivedOrder {
  fact: OrderFact;
  category: OrderCategory;
  totalCents: number;
  refundedCents: number;
  /** Order value net of refunds. */
  netCents: number;
  /** Money actually received (SUCCESS payments, net of refunds). */
  collectedCents: number;
  /** Net value not yet received - for a COD order, the cash still to be collected. */
  outstandingCents: number;
  mode: "COD" | "PREPAID" | null;
  paymentStatus: string | null;
  day: string;
}

const asAmount = (cents: number) => ({ toString: () => (cents / 100).toFixed(2) });

export function deriveOrder(fact: OrderFact): DerivedOrder {
  const pays = fact.payments.map((p) => ({ method: p.method as never, status: p.status as never, amount: asAmount(p.amountCents), refundedAmount: p.refundedCents ? asAmount(p.refundedCents) : null }));
  const breakdown = computePaymentBreakdown(pays);
  const refundedCents = breakdown.refundedCents;
  const netCents = fact.totalCents - refundedCents;
  const collectedCents = breakdown.paidCents;
  let category: OrderCategory;
  if (fact.status === "CANCELLED") category = "CANCELLED";
  else if (fact.status === "RETURNED") category = "RETURNED";
  else if (fact.status === "PENDING_PAYMENT") category = "PENDING_PAYMENT";
  else if (fact.status === "REFUNDED") category = "REFUNDED_IN_FULL";
  else category = netCents > 0 ? "SOLD" : "REFUNDED_IN_FULL"; // a sold order refunded to nothing is not a sale (same rule as the Reports)
  return {
    fact,
    category,
    totalCents: fact.totalCents,
    refundedCents,
    netCents,
    collectedCents,
    outstandingCents: Math.max(netCents - collectedCents, 0),
    mode: derivePaymentMode(pays as never),
    paymentStatus: derivePaymentStatus(pays as never),
    day: istDay(fact.at),
  };
}

const sum = <T,>(xs: readonly T[], f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0);
const money = (paise: number) => rupees(paise);

export function aggregateSales(orders: readonly OrderFact[], days: readonly string[]) {
  const all = orders.map(deriveOrder);
  const sold = all.filter((o) => o.category === "SOLD");
  const of = (c: OrderCategory) => all.filter((o) => o.category === c);
  const grossCents = sum(sold, (o) => o.totalCents);
  const refundedCents = sum(sold, (o) => o.refundedCents);
  const netCents = sum(sold, (o) => o.netCents);
  const slice = (xs: DerivedOrder[]) => ({ orders: xs.length, netRevenue: money(sum(xs, (o) => o.netCents)), collected: money(sum(xs, (o) => o.collectedCents)), outstanding: money(sum(xs, (o) => o.outstandingCents)) });
  const sources = [...new Set(sold.map((o) => o.fact.source))].sort();
  const byDay = new Map<string, DerivedOrder[]>();
  for (const o of sold) byDay.set(o.day, [...(byDay.get(o.day) ?? []), o]);
  return {
    orders: {
      placed: all.length,
      sold: sold.length,
      cancelled: of("CANCELLED").length,
      returned: of("RETURNED").length,
      refundedInFull: of("REFUNDED_IN_FULL").length,
      pendingPayment: of("PENDING_PAYMENT").length,
    },
    revenue: {
      gross: money(grossCents),
      refunded: money(refundedCents),
      net: money(netCents),
      averageOrderValue: sold.length > 0 ? Math.round(netCents / sold.length) / 100 : null,
    },
    notSoldValue: {
      cancelled: money(sum(of("CANCELLED"), (o) => o.totalCents)),
      returned: money(sum(of("RETURNED"), (o) => o.totalCents)),
      refundedInFull: money(sum(of("REFUNDED_IN_FULL"), (o) => o.totalCents)),
      pendingPayment: money(sum(of("PENDING_PAYMENT"), (o) => o.totalCents)),
    },
    collection: { collected: money(sum(sold, (o) => o.collectedCents)), outstanding: money(sum(sold, (o) => o.outstandingCents)) },
    byPaymentMode: {
      cod: slice(sold.filter((o) => o.mode === "COD")),
      prepaid: slice(sold.filter((o) => o.mode === "PREPAID")),
      unclassified: slice(sold.filter((o) => o.mode === null)),
    },
    bySource: sources.map((source) => ({ source, ...slice(sold.filter((o) => o.fact.source === source)) })),
    byDay: days.map((date) => {
      const xs = byDay.get(date) ?? [];
      return { date, orders: xs.length, netRevenue: money(sum(xs, (o) => o.netCents)), collected: money(sum(xs, (o) => o.collectedCents)) };
    }),
  };
}

export function aggregateOrders(orders: readonly OrderFact[], days: readonly string[]) {
  const all = orders.map(deriveOrder);
  const count = (f: (o: DerivedOrder) => boolean) => all.filter(f).length;
  const byDay = new Map<string, number>();
  for (const o of all) byDay.set(o.day, (byDay.get(o.day) ?? 0) + 1);
  return {
    placed: all.length,
    totalValue: money(sum(all, (o) => o.totalCents)),
    byStatus: ORDER_STATUSES.map((status) => {
      const xs = all.filter((o) => o.fact.status === status);
      return { status, orders: xs.length, value: money(sum(xs, (o) => o.totalCents)) };
    }),
    bySource: [...new Set(all.map((o) => o.fact.source))].sort().map((source) => ({ source, orders: count((o) => o.fact.source === source) })),
    byPaymentStatus: [...PAYMENT_STATUSES, "NONE"].map((status) => ({ status, orders: count((o) => (o.paymentStatus ?? "NONE") === status) })),
    byPaymentMode: { cod: count((o) => o.mode === "COD"), prepaid: count((o) => o.mode === "PREPAID"), unclassified: count((o) => o.mode === null) },
    fulfilment: {
      awaitingFulfilment: count((o) => ["PENDING_PAYMENT", "CONFIRMED", "PROCESSING"].includes(o.fact.status)),
      fulfilled: count((o) => FULFILLED.has(o.fact.status)),
      cancelled: count((o) => o.fact.status === "CANCELLED"),
      returnedOrRefunded: count((o) => o.fact.status === "RETURNED" || o.fact.status === "REFUNDED"),
    },
    byDay: days.map((date) => ({ date, orders: byDay.get(date) ?? 0 })),
  };
}

// ----------------------------------------------------------------------------------------------- products

export function aggregateProducts(orders: readonly OrderFact[]) {
  const sold = orders.map(deriveOrder).filter((o) => o.category === "SOLD");
  const rows = new Map<string, { productId: string | null; name: string; sku: string | null; units: number; revenueCents: number; orderCount: number }>();
  let customUnits = 0;
  let customCents = 0;
  let customOrders = 0;
  for (const o of sold) {
    const seen = new Set<string>();
    let customSeen = false;
    for (const item of o.fact.items) {
      if (item.custom || !item.productId) {
        // free-text lines are one bucket and are never named: what a telecaller typed there is not catalogue data
        customUnits += item.units;
        customCents += item.totalCents;
        customSeen = true;
        continue;
      }
      const row = rows.get(item.productId) ?? { productId: item.productId, name: item.name, sku: item.sku, units: 0, revenueCents: 0, orderCount: 0 };
      row.units += item.units;
      row.revenueCents += item.totalCents;
      if (!seen.has(item.productId)) {
        row.orderCount += 1;
        seen.add(item.productId);
      }
      rows.set(item.productId, row);
    }
    if (customSeen) customOrders += 1;
  }
  const list = [...rows.values()].sort((a, b) => b.revenueCents - a.revenueCents || a.name.localeCompare(b.name));
  return {
    soldOrders: sold.length,
    items: list.map((r) => ({ productId: r.productId, name: r.name, sku: r.sku, unitsSold: r.units, orders: r.orderCount, grossRevenue: money(r.revenueCents) })),
    customItems: { unitsSold: customUnits, orders: customOrders, grossRevenue: money(customCents) },
    totals: { unitsSold: sum(list, (r) => r.units) + customUnits, grossRevenue: money(sum(list, (r) => r.revenueCents) + customCents) },
  };
}

// ----------------------------------------------------------------------------------------------- payments

export interface PaymentFact {
  status: string;
  method: string | null;
  provider: string | null;
  amountCents: number;
  refundedCents: number;
  paidAt: Date | null;
  failedAt: Date | null;
  refundedAt: Date | null;
  createdAt: Date;
}

const label = (v: string | null) => v ?? "UNSPECIFIED";

export function aggregatePayments(payments: readonly PaymentFact[], start: Date, end: Date, days: readonly string[]) {
  const captured = payments.filter((p) => COLLECTED_STATUSES.has(p.status) && inRange(p.paidAt, start, end));
  // money confirmed received but never given a date: it cannot be placed in time, so it is reported on its own and left out of the dated totals (never guessed into a day)
  const undatedCaptured = payments.filter((p) => COLLECTED_STATUSES.has(p.status) && !p.paidAt && inRange(p.createdAt, start, end));
  const refunded = payments.filter((p) => p.refundedCents > 0 && inRange(p.refundedAt, start, end));
  const undatedRefunds = payments.filter((p) => p.refundedCents > 0 && !p.refundedAt && inRange(p.createdAt, start, end));
  const failed = payments.filter((p) => p.status === "FAILED" && inRange(p.failedAt ?? p.createdAt, start, end));
  const pending = payments.filter((p) => (p.status === "PENDING" || p.status === "PROCESSING") && inRange(p.createdAt, start, end));
  const group = (xs: readonly PaymentFact[], key: (p: PaymentFact) => string, amount: (p: PaymentFact) => number) =>
    [...new Set(xs.map(key))].sort().map((k) => ({ key: k, payments: xs.filter((p) => key(p) === k).length, amount: money(sum(xs.filter((p) => key(p) === k), amount)) }));
  const capturedCents = sum(captured, (p) => p.amountCents);
  const refundedCents = sum(refunded, (p) => p.refundedCents);
  return {
    captured: {
      payments: captured.length,
      amount: money(capturedCents),
      byMethod: group(captured, (p) => label(p.method), (p) => p.amountCents).map(({ key, ...r }) => ({ method: key, ...r })),
      byProvider: group(captured, (p) => label(p.provider), (p) => p.amountCents).map(({ key, ...r }) => ({ provider: key, ...r })),
    },
    refunds: { payments: refunded.length, amount: money(refundedCents) },
    net: money(capturedCents - refundedCents),
    failed: { payments: failed.length, amount: money(sum(failed, (p) => p.amountCents)) },
    pending: {
      payments: pending.length,
      amount: money(sum(pending, (p) => p.amountCents)),
      cod: { payments: pending.filter((p) => p.method === "COD").length, amount: money(sum(pending.filter((p) => p.method === "COD"), (p) => p.amountCents)) },
      online: { payments: pending.filter((p) => p.method !== "COD").length, amount: money(sum(pending.filter((p) => p.method !== "COD"), (p) => p.amountCents)) },
    },
    undated: { capturedPayments: undatedCaptured.length, capturedAmount: money(sum(undatedCaptured, (p) => p.amountCents)), refundedPayments: undatedRefunds.length, refundedAmount: money(sum(undatedRefunds, (p) => p.refundedCents)) },
    byDay: days.map((date) => ({
      date,
      captured: money(sum(captured.filter((p) => istDay(p.paidAt!) === date), (p) => p.amountCents)),
      refunded: money(sum(refunded.filter((p) => istDay(p.refundedAt!) === date), (p) => p.refundedCents)),
    })),
  };
}

// ----------------------------------------------------------------------------------------------- leads

export interface LeadFact {
  createdAt: Date;
  workingStatus: string;
  lifecycleStage: string;
  ownerId: string | null;
  sourceId: string | null;
  contacted: boolean;
}
export interface SourceFact {
  id: string;
  name: string;
  type: string;
}

export function aggregateLeads(leads: readonly LeadFact[], sources: readonly SourceFact[], days: readonly string[]) {
  const nameOf = new Map(sources.map((s) => [s.id, s]));
  // a lead the team deactivated is not workable and is left out of the conversion rate (the Reports do the same)
  const workable = leads.filter((l) => l.workingStatus !== "DEACTIVATED");
  const converted = workable.filter((l) => l.workingStatus === "CONVERTED");
  const byDay = new Map<string, number>();
  for (const l of leads) byDay.set(istDay(l.createdAt), (byDay.get(istDay(l.createdAt)) ?? 0) + 1);
  const statuses = [...new Set(leads.map((l) => l.workingStatus))].sort();
  const bySource = new Map<string | null, LeadFact[]>();
  for (const l of leads) bySource.set(l.sourceId, [...(bySource.get(l.sourceId) ?? []), l]);
  return {
    newLeads: leads.length,
    workable: workable.length,
    assigned: leads.filter((l) => l.ownerId !== null).length,
    unassigned: leads.filter((l) => l.ownerId === null).length,
    contacted: leads.filter((l) => l.contacted).length,
    converted: converted.length,
    conversionRate: ratio(converted.length, workable.length),
    byStatus: statuses.map((status) => ({ status, leads: leads.filter((l) => l.workingStatus === status).length })),
    byLifecycleStage: [...new Set(leads.map((l) => l.lifecycleStage))].sort().map((stage) => ({ stage, leads: leads.filter((l) => l.lifecycleStage === stage).length })),
    bySource: [...bySource.entries()]
      .map(([id, xs]) => {
        const w = xs.filter((l) => l.workingStatus !== "DEACTIVATED");
        const c = w.filter((l) => l.workingStatus === "CONVERTED").length;
        const s = id ? nameOf.get(id) : undefined;
        return { sourceId: id, name: s?.name ?? (id ? "Unknown source" : "No source"), type: s?.type ?? null, newLeads: xs.length, converted: c, conversionRate: ratio(c, w.length) };
      })
      .sort((a, b) => b.newLeads - a.newLeads || a.name.localeCompare(b.name)),
    byDay: days.map((date) => ({ date, newLeads: byDay.get(date) ?? 0 })),
  };
}

// ----------------------------------------------------------------------------------------------- marketing (only what the CRM actually records)

export interface CampaignFact {
  id: string;
  name: string;
  status: string;
  /** startedAt ?? scheduledAt ?? createdAt */
  at: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  recipientCount: number;
  /** One entry per recipient row: the campaign-recipient status and, when a message was sent, that message's provider status. */
  recipients: { status: string; messageStatus: string | null }[];
}

export function aggregateMarketing(input: { leads: readonly LeadFact[]; sources: readonly SourceFact[]; orders: readonly OrderFact[]; campaigns: readonly CampaignFact[] }) {
  const sold = input.orders.map(deriveOrder).filter((o) => o.category === "SOLD");
  const leadSources = aggregateLeads(input.leads, input.sources, []).bySource.map((row) => {
    const mine = sold.filter((o) => (o.fact.leadSourceId ?? null) === row.sourceId);
    return { ...row, soldOrders: mine.length, netRevenue: money(sum(mine, (o) => o.netCents)) };
  });
  // sources that sold in the period but received no new lead in it still belong in the table
  const listed = new Set(leadSources.map((r) => r.sourceId));
  const sourceSales = [...new Set(sold.map((o) => o.fact.leadSourceId ?? null))].filter((id) => !listed.has(id));
  const nameOf = new Map(input.sources.map((s) => [s.id, s]));
  for (const id of sourceSales) {
    const mine = sold.filter((o) => (o.fact.leadSourceId ?? null) === id);
    leadSources.push({ sourceId: id, name: id ? (nameOf.get(id)?.name ?? "Unknown source") : "No source", type: id ? (nameOf.get(id)?.type ?? null) : null, newLeads: 0, converted: 0, conversionRate: null, soldOrders: mine.length, netRevenue: money(sum(mine, (o) => o.netCents)) });
  }
  const couponIds = [...new Set(sold.filter((o) => o.fact.couponId).map((o) => o.fact.couponId!))];
  const coupons = couponIds
    .map((id) => {
      const mine = sold.filter((o) => o.fact.couponId === id);
      return { couponId: id, code: mine[0]!.fact.couponCode, ordersUsed: mine.length, discountGiven: money(sum(mine, (o) => o.fact.discountCents)), netRevenue: money(sum(mine, (o) => o.netCents)) };
    })
    .sort((a, b) => b.ordersUsed - a.ordersUsed || String(a.code).localeCompare(String(b.code)));
  const count = (c: CampaignFact, f: (r: CampaignFact["recipients"][number]) => boolean) => c.recipients.filter(f).length;
  return {
    leadSources: leadSources.sort((a, b) => b.newLeads - a.newLeads || b.soldOrders - a.soldOrders || a.name.localeCompare(b.name)),
    coupons: { ordersWithCoupon: sold.filter((o) => o.fact.couponId).length, soldOrders: sold.length, discountGiven: money(sum(sold.filter((o) => o.fact.couponId), (o) => o.fact.discountCents)), byCoupon: coupons },
    whatsappCampaigns: [...input.campaigns]
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((c) => ({
        campaignId: c.id,
        name: c.name,
        status: c.status,
        startedAt: c.startedAt ? c.startedAt.toISOString() : null,
        completedAt: c.completedAt ? c.completedAt.toISOString() : null,
        recipients: c.recipientCount,
        // recipient outcome (what the CRM did)
        pending: count(c, (r) => r.status === "PENDING" || r.status === "CLAIMED"),
        sent: count(c, (r) => r.status === "SENT"),
        skipped: count(c, (r) => r.status === "SKIPPED"),
        failed: count(c, (r) => r.status === "FAILED"),
        // what WhatsApp then reported about the messages that were sent (provider callbacks; null counts are never guessed)
        delivered: count(c, (r) => r.messageStatus === "DELIVERED" || r.messageStatus === "READ"),
        read: count(c, (r) => r.messageStatus === "READ"),
      })),
  };
}

// ----------------------------------------------------------------------------------------------- telecallers (merging the Reports' per-window figures)

export interface TelecallerWindowRow {
  id: string;
  name: string;
  accountStatus: string;
  leads: number;
  contacted: number;
  interested: number;
  converted: number;
  calls: number;
  connected: number;
  notConnected: number;
  failed: number;
  uniqueLeads: number;
  talkTimeSec: number;
  productiveMs: number;
  orders: number;
  codOrders: number;
  prepaidOrders: number;
  assistedOrders: number;
  revenue: number;
  assistedRevenue: number;
  collected: number;
  codRevenue: number;
  codCollected: number;
  prepaidRevenue: number;
  prepaidCollected: number;
}

const ADDITIVE = ["leads", "contacted", "interested", "converted", "calls", "connected", "notConnected", "failed", "talkTimeSec", "productiveMs", "orders", "codOrders", "prepaidOrders", "assistedOrders"] as const;
const MONEY = ["revenue", "assistedRevenue", "collected", "codRevenue", "codCollected", "prepaidRevenue", "prepaidCollected"] as const;

/**
 * The Reports' telecaller analytics accept at most 92 days at a time, the HRMS API accepts any range: a long range is read in consecutive windows and added up. Every figure is a count or an amount over
 * disjoint days, so addition is exact - except "unique leads called", which would double count a lead called in two windows: for a multi-window range it is null, never an inflated number.
 */
export function mergeTelecallerWindows(windows: readonly (readonly TelecallerWindowRow[])[]) {
  const people = new Map<string, TelecallerWindowRow & { windows: number }>();
  for (const rows of windows) {
    for (const r of rows) {
      const have = people.get(r.id);
      if (!have) {
        people.set(r.id, { ...r, windows: 1 });
        continue;
      }
      for (const k of ADDITIVE) have[k] += r[k];
      for (const k of MONEY) have[k] = Math.round((have[k] + r[k]) * 100) / 100;
      have.uniqueLeads += r.uniqueLeads;
      have.windows += 1;
      have.name = r.name;
      have.accountStatus = r.accountStatus;
    }
  }
  const single = windows.length <= 1;
  return [...people.values()]
    .map((p) => ({
      employeeId: p.id,
      name: p.name,
      accountStatus: p.accountStatus,
      leads: { received: p.leads, contacted: p.contacted, interested: p.interested, converted: p.converted, conversionRate: ratio(p.converted, p.leads) },
      calls: { total: p.calls, connected: p.connected, notConnected: p.notConnected, failed: p.failed, connectRate: ratio(p.connected, p.calls), talkTimeSeconds: p.talkTimeSec, uniqueLeadsCalled: single ? p.uniqueLeads : null },
      productiveSeconds: Math.round(p.productiveMs / 1000),
      sales: {
        orders: p.orders,
        codOrders: p.codOrders,
        prepaidOrders: p.prepaidOrders,
        assistedOrders: p.assistedOrders,
        netRevenue: p.revenue,
        assistedRevenue: p.assistedRevenue,
        collected: p.collected,
        codNetRevenue: p.codRevenue,
        codCollected: p.codCollected,
        prepaidNetRevenue: p.prepaidRevenue,
        prepaidCollected: p.prepaidCollected,
        averageOrderValue: p.orders > 0 ? Math.round((p.revenue / p.orders) * 100) / 100 : null,
      },
    }))
    .sort((a, b) => b.sales.netRevenue - a.sales.netRevenue || a.name.localeCompare(b.name));
}

export type TelecallerOut = ReturnType<typeof mergeTelecallerWindows>[number];

export function teamTotals(rows: readonly TelecallerOut[]) {
  const s = (f: (r: TelecallerOut) => number) => Math.round(sum(rows, f) * 100) / 100;
  return {
    telecallers: rows.length,
    leadsReceived: s((r) => r.leads.received),
    leadsConverted: s((r) => r.leads.converted),
    calls: s((r) => r.calls.total),
    connectedCalls: s((r) => r.calls.connected),
    talkTimeSeconds: s((r) => r.calls.talkTimeSeconds),
    orders: s((r) => r.sales.orders),
    netRevenue: s((r) => r.sales.netRevenue),
    collected: s((r) => r.sales.collected),
  };
}
