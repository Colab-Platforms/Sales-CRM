import { prisma } from "@/lib/prisma.js";
import { OrderStatus } from "../../../generated/prisma/enums.js";
import { computePaymentBreakdown, derivePaymentMode, derivePaymentStatus } from "../orders/orders.filters.js";
import { classify, closingCall, matchesCallStatus, matchesLeadStatus, type CallStatusFilter, type LeadStatusFilter } from "./manager.metrics.js";

// ---------------------------------------------------------------------------------------------
// Sales & Revenue: one definition shared by the KPI cards, charts, tables and exports.
//
//  Eligible order  status CONFIRMED / PROCESSING / SHIPPED / OUT_FOR_DELIVERY / DELIVERED (never draft,
//                  pending payment, cancelled, returned or refunded), dated by when the sale happened:
//                  confirmedAt ?? placedAt ?? createdAt, in the report timezone.
//  Credit          who the sale counts for (each order counts once, for one person):
//                    CONFIRMED  a team member confirmed it in the CRM (Order.confirmedByUserId).
//                    ASSISTED   nobody on any team confirmed it in the CRM (e.g. the customer completed the
//                               purchase on Shopify) and a team member called or worked that same customer (same
//                               Lead.normalizedMobile, on any of their lead records) within ASSIST_WINDOW_DAYS
//                               before the sale; the most recent such contact wins.
//                  Lead ownership alone never earns credit, and an order with neither is not counted.
//  Order value     Order.totalAmount minus refunds recorded on its payments. An order refunded in full
//                  is no longer a sale and drops out. This is the "Revenue" figure (booked, not cash).
//  Collected       money actually received: SUCCESS payments net of refunds (computePaymentBreakdown).
//                  A COD order counts as collected only once its COD payment is marked SUCCESS.
//  COD / Prepaid   the orders module's derivePaymentMode: COD if any payment is COD, otherwise prepaid if
//                  any payment has a method. An order with no payment method yet is in the totals but in
//                  neither split (and is excluded when a payment-method filter is chosen).
//  Counting        per order, never per payment row, so retries and upgrades are not double counted.
//  Call filter     an order follows its closing call: the credited telecaller's latest call to that lead
//                  at or before the sale. "Failed calls" therefore shows only orders that came from a
//                  failed call; an order with no such call appears only under "All calls".
//  Lead filter     a credited order is a lead its telecaller worked and converted: it appears under every lead
//                  filter except "Not contacted".
// ---------------------------------------------------------------------------------------------

export const SOLD_STATUSES: OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
];

/** How far back a telecaller's call or action on a lead still earns credit for that customer's order. */
export const ASSIST_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

export type PaymentModeFilter = "ALL" | "COD" | "PREPAID";
export type OrderStatusFilter = "ALL" | (typeof SOLD_STATUSES)[number];
export type SaleCredit = "CONFIRMED" | "ASSISTED";

export interface SalesFilters {
  paymentMode: PaymentModeFilter;
  orderStatus: OrderStatusFilter;
  callStatus: CallStatusFilter;
  leadStatus: LeadStatusFilter;
}

export interface SoldItem {
  key: string;
  name: string;
  sku: string | null;
  units: number;
  cents: number;
}

export interface SoldOrder {
  id: string;
  orderNumber: string;
  externalNumber: string | null;
  source: string;
  status: OrderStatus;
  currency: string;
  /** The team member the sale is credited to. */
  userId: string;
  credit: SaleCredit;
  at: Date;
  totalCents: number;
  refundedCents: number;
  /** Order value net of refunds, in paise. */
  cents: number;
  /** Money received (SUCCESS payments net of refunds), in paise. */
  collectedCents: number;
  mode: "COD" | "PREPAID" | null;
  paymentStatus: string | null;
  items: SoldItem[];
}

export interface Touch {
  userId: string;
  at: Date;
}

/**
 * Who a sale counts for. `confirmedBy` is the CRM confirmer when that person is on the team being reported;
 * `confirmedByAnySalesperson` stops an order another team's telecaller confirmed from being re-credited here.
 */
export function creditFor(
  sale: { at: Date; confirmedBy: string | null; confirmedByAnySalesperson: boolean },
  touches: Touch[],
): { userId: string; credit: SaleCredit } | null {
  if (sale.confirmedBy) return { userId: sale.confirmedBy, credit: "CONFIRMED" };
  if (sale.confirmedByAnySalesperson) return null;
  const from = sale.at.getTime() - ASSIST_WINDOW_DAYS * DAY_MS;
  let best: Touch | null = null;
  for (const t of touches) {
    const ms = t.at.getTime();
    if (ms < from || ms > sale.at.getTime()) continue;
    if (!best || ms > best.at.getTime()) best = t;
  }
  return best ? { userId: best.userId, credit: "ASSISTED" } : null;
}

const toPaise = (v: { toString(): string }) => Math.round(Number(v.toString()) * 100);

/** Eligible orders credited to `userIds` (see Credit above) that happened in [start, end), narrowed by the filters. */
export async function soldOrders(userIds: string[], start: Date, end: Date, f: SalesFilters): Promise<SoldOrder[]> {
  if (userIds.length === 0) return [];
  const team = new Set(userIds);
  const inRange = { gte: start, lt: end };
  const touchedFrom = new Date(start.getTime() - ASSIST_WINDOW_DAYS * DAY_MS);
  const recentTouch = { gte: touchedFrom, lt: end };

  // 1. Everything the team did with customers in the window: calls and actions, keyed by the customer. A customer
  //    is their standard phone number (Lead.normalizedMobile, "+91XXXXXXXXXX"), because an abandoned checkout and the
  //    Shopify order that follows can land on two different lead records for the same person.
  const [windowCalls, windowActions] = await Promise.all([
    prisma.call.findMany({
      where: { agentId: { in: userIds }, leadId: { not: null }, createdAt: recentTouch },
      select: { leadId: true, agentId: true, status: true, startedAt: true, createdAt: true, lead: { select: { normalizedMobile: true } } },
    }),
    prisma.activity.findMany({
      where: { actorId: { in: userIds }, leadId: { not: null }, createdAt: recentTouch },
      select: { leadId: true, actorId: true, createdAt: true, lead: { select: { normalizedMobile: true } } },
    }),
  ]);
  const customerKey = (leadId: string, phone: string | null | undefined) => phone || `lead:${leadId}`;
  const touchesByCustomer = new Map<string, Touch[]>();
  const callsByCustomer = new Map<string, (typeof windowCalls)[number][]>();
  const push = <T,>(map: Map<string, T[]>, key: string, value: T) => map.set(key, [...(map.get(key) ?? []), value]);
  for (const c of windowCalls) {
    const key = customerKey(c.leadId!, c.lead?.normalizedMobile);
    push(touchesByCustomer, key, { userId: c.agentId, at: c.startedAt ?? c.createdAt });
    push(callsByCustomer, key, c);
  }
  for (const a of windowActions) push(touchesByCustomer, customerKey(a.leadId!, a.lead?.normalizedMobile), { userId: a.actorId!, at: a.createdAt });
  const touchedLeadIds = [...new Set([...windowCalls, ...windowActions].map((t) => t.leadId!))];
  const touchedPhones = [...new Set([...windowCalls, ...windowActions].map((t) => t.lead?.normalizedMobile).filter((p): p is string => Boolean(p)))];

  // 2. Orders in the period: confirmed by the team, or not confirmed by any salesperson and bought by a customer the team worked.
  const orders = await prisma.order.findMany({
    where: {
      status: f.orderStatus === "ALL" ? { in: SOLD_STATUSES } : f.orderStatus,
      AND: [
        // When the sale happened.
        { OR: [{ confirmedAt: inRange }, { confirmedAt: null, placedAt: inRange }, { confirmedAt: null, placedAt: null, createdAt: inRange }] },
        {
          OR: [
            { confirmedByUserId: { in: userIds } },
            {
              AND: [
                { OR: [{ confirmedByUserId: null }, { confirmedBy: { role: { not: "SALESPERSON" } } }] },
                { lead: { OR: [{ id: { in: touchedLeadIds } }, { normalizedMobile: { in: touchedPhones } }] } },
              ],
            },
          ],
        },
      ],
    },
    select: {
      id: true,
      orderNumber: true,
      externalNumber: true,
      source: true,
      status: true,
      currency: true,
      totalAmount: true,
      confirmedAt: true,
      placedAt: true,
      createdAt: true,
      confirmedByUserId: true,
      confirmedBy: { select: { role: true } },
      leadId: true,
      lead: { select: { normalizedMobile: true } },
      payments: { select: { method: true, status: true, amount: true, refundedAmount: true } },
      items: { select: { productId: true, productNameSnapshot: true, skuSnapshot: true, quantity: true, totalPrice: true } },
    },
  });
  if (orders.length === 0) return [];

  // 3. Closing calls for the call-status filter: the window calls above, plus older calls on the orders' own leads
  //    (a CRM confirmation can follow a call made long before the period).
  const olderCalls =
    f.callStatus === "ALL"
      ? []
      : await prisma.call.findMany({
          where: { leadId: { in: [...new Set(orders.map((o) => o.leadId))] }, agentId: { in: userIds }, createdAt: { lt: touchedFrom } },
          select: { leadId: true, agentId: true, status: true, startedAt: true, createdAt: true },
        });

  const sales = orders.flatMap((o): SoldOrder[] => {
    const at = o.confirmedAt ?? o.placedAt ?? o.createdAt;
    const key = customerKey(o.leadId, o.lead.normalizedMobile);
    const credited = creditFor(
      {
        at,
        confirmedBy: o.confirmedByUserId && team.has(o.confirmedByUserId) ? o.confirmedByUserId : null,
        confirmedByAnySalesperson: o.confirmedBy?.role === "SALESPERSON",
      },
      touchesByCustomer.get(key) ?? [],
    );
    if (!credited) return [];
    // A credited order means its telecaller worked and converted that lead.
    if (!matchesLeadStatus({ touched: true, interested: true, converted: true }, f.leadStatus)) return [];
    if (f.callStatus !== "ALL") {
      // The customer's calls, wherever their lead record is, treated as calls on this order's lead.
      const customerCalls = [...(callsByCustomer.get(key) ?? []), ...olderCalls.filter((c) => c.leadId === o.leadId)].map((c) => ({ ...c, leadId: o.leadId }));
      const closing = closingCall(customerCalls, { leadId: o.leadId, confirmedByUserId: credited.userId, confirmedAt: at });
      if (!matchesCallStatus(closing ? classify(closing.status) : null, f.callStatus)) return [];
    }
    const breakdown = computePaymentBreakdown(o.payments);
    const totalCents = toPaise(o.totalAmount);
    const cents = totalCents - breakdown.refundedCents;
    if (cents <= 0) return [];
    const mode = derivePaymentMode(o.payments);
    if (f.paymentMode !== "ALL" && mode !== f.paymentMode) return [];
    return [
      {
        id: o.id,
        orderNumber: o.orderNumber,
        externalNumber: o.externalNumber,
        source: o.source,
        status: o.status,
        currency: o.currency,
        userId: credited.userId,
        credit: credited.credit,
        at,
        totalCents,
        refundedCents: breakdown.refundedCents,
        cents,
        collectedCents: breakdown.paidCents,
        mode,
        paymentStatus: derivePaymentStatus(o.payments),
        items: o.items.map((i) => ({
          // Variants roll up to their product; a line with no catalog product groups by its name.
          key: i.productId ?? `name:${i.productNameSnapshot.trim().toLowerCase()}`,
          name: i.productNameSnapshot,
          sku: i.skuSnapshot,
          units: i.quantity,
          cents: toPaise(i.totalPrice),
        })),
      },
    ];
  });
  return sales.sort((a, b) => a.at.getTime() - b.at.getTime());
}

// --- tallies (integer paise, so totals never drift; converted to rupees once on the way out)

export interface SalesCents {
  orders: number;
  revenue: number;
  /** Of which: credited because the customer bought after the telecaller's call/action (see Credit). */
  assistedOrders: number;
  assistedRevenue: number;
  collected: number;
  codOrders: number;
  codRevenue: number;
  codCollected: number;
  prepaidOrders: number;
  prepaidRevenue: number;
  prepaidCollected: number;
}

export const emptySales = (): SalesCents => ({
  orders: 0,
  revenue: 0,
  assistedOrders: 0,
  assistedRevenue: 0,
  collected: 0,
  codOrders: 0,
  codRevenue: 0,
  codCollected: 0,
  prepaidOrders: 0,
  prepaidRevenue: 0,
  prepaidCollected: 0,
});

export function addSale(t: SalesCents, sale: Pick<SoldOrder, "cents" | "collectedCents" | "mode"> & { credit?: SaleCredit }): void {
  t.orders += 1;
  t.revenue += sale.cents;
  if (sale.credit === "ASSISTED") {
    t.assistedOrders += 1;
    t.assistedRevenue += sale.cents;
  }
  t.collected += sale.collectedCents;
  if (sale.mode === "COD") {
    t.codOrders += 1;
    t.codRevenue += sale.cents;
    t.codCollected += sale.collectedCents;
  } else if (sale.mode === "PREPAID") {
    t.prepaidOrders += 1;
    t.prepaidRevenue += sale.cents;
    t.prepaidCollected += sale.collectedCents;
  }
}

export function mergeSales(into: SalesCents, from: SalesCents): void {
  for (const key of Object.keys(into) as (keyof SalesCents)[]) into[key] += from[key];
}

/** Rupee view of a tally. AOV is order value ÷ eligible orders, and 0 when there are no orders. */
export const salesOut = (t: SalesCents = emptySales()) => ({
  orders: t.orders,
  codOrders: t.codOrders,
  prepaidOrders: t.prepaidOrders,
  revenue: t.revenue / 100,
  assistedOrders: t.assistedOrders,
  assistedRevenue: t.assistedRevenue / 100,
  collected: t.collected / 100,
  codRevenue: t.codRevenue / 100,
  codCollected: t.codCollected / 100,
  prepaidRevenue: t.prepaidRevenue / 100,
  prepaidCollected: t.prepaidCollected / 100,
  aov: t.orders > 0 ? Math.round(t.revenue / t.orders) / 100 : 0,
});

// --- CSV export

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @, tab, CR) is prefixed with
 * an apostrophe so it stays text; numbers are written as plain numbers.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const MODE_LABEL = { COD: "COD", PREPAID: "Prepaid" } as const;

/** Every matching order as UTF-8 CSV (with BOM for Excel). No customer contact details are included. */
export function ordersCsv(orders: SoldOrder[], nameOf: Map<string, string>, tzOffsetMinutes: number): string {
  const local = (d: Date) => new Date(d.getTime() + tzOffsetMinutes * 60_000).toISOString();
  const header = [
    "Order Number", "Shopify Number", "Sale At (IST)", "Business Date", "Salesperson", "Credit", "Order Status", "Payment Method",
    "Payment Status", "Source", "Currency", "Items", "Units", "Order Total", "Refunded", "Order Value (net)", "Collected", "Outstanding",
  ];
  const rows = orders.map((o) => [
    o.orderNumber,
    o.externalNumber,
    local(o.at).slice(0, 19).replace("T", " "),
    local(o.at).slice(0, 10),
    nameOf.get(o.userId) ?? "",
    o.credit === "CONFIRMED" ? "Confirmed in CRM" : `Assisted (contacted within ${ASSIST_WINDOW_DAYS} days before)`,
    o.status,
    o.mode ? MODE_LABEL[o.mode] : "Unknown",
    o.paymentStatus ?? "None",
    o.source,
    o.currency,
    o.items.length,
    o.items.reduce((a, i) => a + i.units, 0),
    o.totalCents / 100,
    o.refundedCents / 100,
    o.cents / 100,
    o.collectedCents / 100,
    Math.max(o.cents - o.collectedCents, 0) / 100,
  ]);
  return "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
