import { prisma } from "@/lib/prisma.js";
import { OrderStatus } from "../../../generated/prisma/enums.js";
import { computePaymentBreakdown, derivePaymentMode, derivePaymentStatus } from "../orders/orders.filters.js";
import { classify, closingCall, matchesCallStatus, matchesLeadStatus, type CallStatusFilter, type LeadStatusFilter } from "./manager.metrics.js";

// ---------------------------------------------------------------------------------------------
// Sales & Revenue: one definition shared by the KPI cards, charts, tables and exports.
//
//  Eligible order  status CONFIRMED / PROCESSING / SHIPPED / OUT_FOR_DELIVERY / DELIVERED (never draft,
//                  pending payment, cancelled, returned or refunded), closed by a team member
//                  (Order.confirmedByUserId) and dated by Order.confirmedAt in the report timezone.
//  Order value     Order.totalAmount minus refunds recorded on its payments. An order refunded in full
//                  is no longer a sale and drops out. This is the "Revenue" figure (booked, not cash).
//  Collected       money actually received: SUCCESS payments net of refunds (computePaymentBreakdown).
//                  A COD order counts as collected only once its COD payment is marked SUCCESS.
//  COD / Prepaid   the orders module's derivePaymentMode: COD if any payment is COD, otherwise prepaid if
//                  any payment has a method. An order with no payment method yet is in the totals but in
//                  neither split (and is excluded when a payment-method filter is chosen).
//  Counting        per order, never per payment row, so retries and upgrades are not double counted.
//  Call filter     an order follows its closing call: the confirming telecaller's latest call to that lead
//                  at or before confirmation. "Failed calls" therefore shows only orders that came from a
//                  failed call; an order with no such call appears only under "All calls".
//  Lead filter     a confirmed order is a lead its telecaller worked and converted: it appears under every lead
//                  filter except "Not contacted".
// ---------------------------------------------------------------------------------------------

export const SOLD_STATUSES: OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
];

export type PaymentModeFilter = "ALL" | "COD" | "PREPAID";
export type OrderStatusFilter = "ALL" | (typeof SOLD_STATUSES)[number];

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
  userId: string;
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

const toPaise = (v: { toString(): string }) => Math.round(Number(v.toString()) * 100);

/** Eligible orders closed by `userIds` with confirmedAt in [start, end), narrowed by the sales filters. */
export async function soldOrders(userIds: string[], start: Date, end: Date, f: SalesFilters): Promise<SoldOrder[]> {
  if (userIds.length === 0) return [];
  const orders = await prisma.order.findMany({
    where: {
      status: f.orderStatus === "ALL" ? { in: SOLD_STATUSES } : f.orderStatus,
      confirmedByUserId: { in: userIds },
      confirmedAt: { gte: start, lt: end },
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
      confirmedByUserId: true,
      leadId: true,
      payments: { select: { method: true, status: true, amount: true, refundedAmount: true } },
      items: { select: { productId: true, productNameSnapshot: true, skuSnapshot: true, quantity: true, totalPrice: true } },
    },
    orderBy: { confirmedAt: "asc" },
  });

  // Closing calls are only needed when a call-status filter is on: one query for every lead involved.
  const calls =
    f.callStatus === "ALL" || orders.length === 0
      ? []
      : await prisma.call.findMany({
          where: { leadId: { in: [...new Set(orders.map((o) => o.leadId))] }, agentId: { in: userIds } },
          select: { leadId: true, agentId: true, status: true, startedAt: true, createdAt: true },
        });

  return orders.flatMap((o): SoldOrder[] => {
    if (!o.confirmedByUserId || !o.confirmedAt) return [];
    // A confirmed order means its confirming telecaller worked and converted that lead.
    const leadStage = { touched: true, interested: true, converted: true };
    if (!matchesLeadStatus(leadStage, f.leadStatus)) return [];
    if (f.callStatus !== "ALL") {
      const closing = closingCall(calls, { leadId: o.leadId, confirmedByUserId: o.confirmedByUserId, confirmedAt: o.confirmedAt });
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
        userId: o.confirmedByUserId,
        at: o.confirmedAt,
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
}

// --- tallies (integer paise, so totals never drift; converted to rupees once on the way out)

export interface SalesCents {
  orders: number;
  revenue: number;
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
  collected: 0,
  codOrders: 0,
  codRevenue: 0,
  codCollected: 0,
  prepaidOrders: 0,
  prepaidRevenue: 0,
  prepaidCollected: 0,
});

export function addSale(t: SalesCents, sale: Pick<SoldOrder, "cents" | "collectedCents" | "mode">): void {
  t.orders += 1;
  t.revenue += sale.cents;
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
    "Order Number", "Shopify Number", "Confirmed At (IST)", "Business Date", "Salesperson", "Order Status", "Payment Method",
    "Payment Status", "Source", "Currency", "Items", "Units", "Order Total", "Refunded", "Order Value (net)", "Collected", "Outstanding",
  ];
  const rows = orders.map((o) => [
    o.orderNumber,
    o.externalNumber,
    local(o.at).slice(0, 19).replace("T", " "),
    local(o.at).slice(0, 10),
    nameOf.get(o.userId) ?? "",
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
