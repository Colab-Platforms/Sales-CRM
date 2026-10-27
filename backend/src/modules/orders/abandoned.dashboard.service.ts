import ExcelJS from "exceljs";
import { Prisma } from "../../../generated/prisma/client.js";
import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { AbandonmentStatus, AbandonmentType, RecoveryActionStatus, Role } from "../../../generated/prisma/enums.js";
import { abandonmentLeadScope, abandonmentSearchWhere } from "../abandonment/abandonment.filters.js";
import { previousRange, resolveDashboardRange, type DashboardRange, type DashboardRangeInput } from "./orders.dashboard.range.js";
import { bucketsFor, compare, coverageOf, INTERVALS, TRUNC_UNIT, type Coverage, type Interval } from "./orders.dashboard.insights.js";
import { dayBounds } from "../report-automation/report-automation.report.js";
import { safeCell } from "../report-automation/report-automation.xlsx.js";
import { addSale, emptySales, salesOut, SOLD_STATUSES } from "../manager/manager.sales.js";
import { computePaymentBreakdown, derivePaymentMode, derivePaymentStatus } from "./orders.filters.js";
import { toCents } from "../shopify/shopify.money.js";
import { PaymentStatus } from "../../../generated/prisma/enums.js";

// ABANDONED CHECKOUTS DASHBOARD. Read-only over the CRM's existing `abandonments` table - nothing is written and no external call is made.
//
// WHERE THE DATA COMES FROM: abandoned checkouts reach the CRM from the Shiprocket Checkout (Fastrr) abandon-cart webhook and from the abandoned-lead CSV import; both save an Abandonment row (type CHECKOUT)
// with the customer's lead, the saved cart (value, items, stage, checkout link) and the time it was detected. This is NOT Shopify's own abandonedCheckouts API (which this CRM does not use). Nothing is
// inferred from orders: an order never becomes an abandoned checkout, and a cart that has been RECOVERED (the purchase completed) is not counted as abandoned.
//
// DEFINITIONS (all for the selected date range, by the time the checkout was detected, in the business timezone):
//   Total abandoned checkouts  = detected checkouts that are not RECOVERED.
//   Potential abandoned value  = the cart value of those that are still open (ACTIVE or IN_PROGRESS) - what could still be won back. Carts without a numeric value add 0; non-INR carts are not summed.
//   Follow-up completed        = not recovered, and at least one recovery action (call / callback / continue-order) has finished (SUCCESS or FAILED).
//   Follow-up pending          = not recovered, and no recovery action has finished yet (none started, or still PENDING / IN_PROGRESS).
//   Recovered                  = purchase completed after the checkout was abandoned (shown for transparency; not part of the totals above).
//   COD / prepaid is NOT read from the abandoned-checkout event (it carries no payment mode). It comes from the ORDER a telecaller created from the checkout - see CONVERSION below.
//
// CONVERSION (the cohort is the checkouts DETECTED in the selected range, so converted <= detected and the rate never exceeds 100%; the order itself may be placed later):
//   Link        = Order.metadata.abandonment.id (written only when a telecaller creates an order from that checkout, and only for the checkout's own customer) on a SALESPERSON order. Nothing is matched by
//                 phone, amount or timing; a website order, or any order without that link, is never a conversion. This is the ONLY thing this file decides itself.
//   Everything else is the REPORTS section's own rules, imported from it (manager.sales.ts / orders.filters.ts), not re-implemented:
//     eligible order   SOLD_STATUSES (confirmed / processing / shipped / out for delivery / delivered - never draft, pending payment, cancelled, returned or refunded)
//     revenue          Order.totalAmount minus refunds recorded on its payments (an order refunded in full drops out); nothing else is added, so tax / shipping / discount are not counted twice
//     COD / prepaid    derivePaymentMode(payments); an order with no payment method yet is in neither and is not counted
//     tallies          emptySales / addSale / salesOut - the same integer-paise tallies as the Reports cards
//   One extra guard (kept from the brief): a PREPAID order counts only when derivePaymentStatus is SUCCESS or PARTIALLY_REFUNDED (a verified payment, net of the refund); otherwise it is shown as "awaiting payment", not converted, not revenue.
//   Several qualifying orders for one checkout: the checkout is counted ONCE, with its earliest sale (confirmedAt ?? placedAt ?? createdAt), so repeats cannot inflate counts or revenue.
//   Telecaller      = who confirmed the order in the CRM (the Reports credit), else who created it.
//   Open vs converted: a converted checkout is removed from the open cards (total / value / pending / completed) so it is never both. RECOVERED (a logged recovery) stays its own card.
// WHO SEES WHAT: the existing abandoned-lead visibility - an Admin sees every checkout, a Manager the ones assigned to them (abandonmentLeadScope).

export type AbandonedMetric = "TOTAL" | "VALUE" | "PENDING" | "DONE" | "RECOVERED" | "CONVERTED" | "DETECTED" | "COD" | "PREPAID";
export const ABANDONED_METRICS: readonly AbandonedMetric[] = ["TOTAL", "VALUE", "PENDING", "DONE", "RECOVERED", "CONVERTED", "DETECTED", "COD", "PREPAID"];

/** The converted checkouts of a range, split by the linked order's payment mode (see CONVERSION): what the open cards exclude and what the conversion cards list. */
export interface ConvertedIds {
  converted: readonly string[];
  cod: readonly string[];
  prepaid: readonly string[];
}
const NO_CONVERTED: ConvertedIds = { converted: [], cod: [], prepaid: [] };

export interface AbandonedFilters extends DashboardRangeInput {
  metric?: AbandonedMetric;
  search?: string;
}

const VERIFIED_PAYMENT: PaymentStatus[] = [PaymentStatus.SUCCESS, PaymentStatus.PARTIALLY_REFUNDED];
export const MAX_ABANDONED_PAGE_SIZE = 100;
export const MAX_ABANDONED_EXPORT_ROWS = 20_000;

const OPEN = [AbandonmentStatus.ACTIVE, AbandonmentStatus.IN_PROGRESS];
const FINISHED = [RecoveryActionStatus.SUCCESS, RecoveryActionStatus.FAILED];
const notRecovered: Prisma.AbandonmentWhereInput = { status: { not: AbandonmentStatus.RECOVERED } };
const finishedAction: Prisma.AbandonmentWhereInput = { recoveryActions: { some: { status: { in: FINISHED } } } };

/** The definition of each card: its number and the rows behind it come from this one clause. */
export function abandonedMetricWhere(metric: AbandonedMetric, ids: ConvertedIds = NO_CONVERTED): Prisma.AbandonmentWhereInput {
  const convertedIds = ids.converted;
  const notConverted: Prisma.AbandonmentWhereInput = convertedIds.length > 0 ? { id: { notIn: [...convertedIds] } } : {}; // a converted checkout is not an open one
  switch (metric) {
    case "TOTAL":
      return { AND: [notRecovered, notConverted] };
    case "VALUE":
      return { AND: [{ status: { in: OPEN } }, notConverted] };
    case "PENDING":
      return { AND: [notRecovered, notConverted, { NOT: finishedAction }] };
    case "DONE":
      return { AND: [notRecovered, notConverted, finishedAction] };
    case "RECOVERED":
      return { status: AbandonmentStatus.RECOVERED };
    case "CONVERTED":
      return { id: { in: [...convertedIds] } };
    case "COD":
      return { id: { in: [...ids.cod] } };
    case "PREPAID":
      return { id: { in: [...ids.prepaid] } };
    case "DETECTED": // every checkout of the range once, whatever became of it
      return {};
  }
}

/** Range (by detection time) + the checkout type + the viewer's own visibility. */
export function abandonedBaseWhere(user: { id: string; role: Role }, range: DashboardRange): Prisma.AbandonmentWhereInput {
  const scope = abandonmentLeadScope(user);
  return { type: AbandonmentType.CHECKOUT, detectedAt: { gte: range.start, lt: range.end }, ...(Object.keys(scope).length > 0 ? { lead: scope } : {}) };
}

const ROW_SELECT = {
  id: true,
  detectedAt: true,
  status: true,
  recoveredAt: true,
  cartSnapshot: true,
  lead: { select: { firstName: true, lastName: true, mobile: true, email: true, owner: { select: { name: true } } } },
  recoveryActions: { select: { type: true, status: true, createdAt: true }, orderBy: { createdAt: "desc" as const }, take: 1 },
} satisfies Prisma.AbandonmentSelect;
type Row = Prisma.AbandonmentGetPayload<{ select: typeof ROW_SELECT }>;

const num = (v: unknown): number | null => (typeof v === "string" && /^[0-9]+(\.[0-9]+)?$/.test(v) ? Number(v) : typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function followUpOf(status: AbandonmentStatus, finished: boolean): "RECOVERED" | "DONE" | "PENDING" {
  return status === AbandonmentStatus.RECOVERED ? "RECOVERED" : finished ? "DONE" : "PENDING";
}

export interface ConvertedOrder {
  orderNumber: string;
  mode: "COD" | "PREPAID";
  status: string;
  paymentStatus: string | null;
  amount: number;
  collected: number;
  telecaller: string | null;
}

export const mapAbandonedRow = (o: Row, finished: boolean, order: ConvertedOrder | null = null) => {
  const snap = (o.cartSnapshot && typeof o.cartSnapshot === "object" ? o.cartSnapshot : {}) as Record<string, unknown>;
  const last = o.recoveryActions[0] ?? null;
  return {
    id: o.id,
    checkoutDate: o.detectedAt,
    customerName: [o.lead.firstName, o.lead.lastName].filter(Boolean).join(" "),
    phone: o.lead.mobile,
    email: o.lead.email,
    amount: num(snap.cartValue),
    currency: text(snap.currency),
    itemCount: typeof snap.itemCount === "number" ? snap.itemCount : null,
    items: Array.isArray(snap.itemNames) ? (snap.itemNames as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 5) : [],
    checkoutLink: text(snap.checkoutUrl),
    stage: text(snap.stage),
    status: o.status,
    followUp: followUpOf(o.status, finished),
    lastAction: last ? { type: last.type, status: last.status, at: last.createdAt } : null,
    assignedTo: o.lead.owner?.name ?? null,
    /** The order this checkout became (null = not converted): the same order the conversion cards count. */
    order,
  };
};

export class AbandonedDashboardService {
  constructor(
    private readonly db: DbClient = prisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private assertAllowed(user: Pick<AuthUser, "role">): void {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
  }

  private async openValue(user: AuthUser, range: DashboardRange, ids: ConvertedIds): Promise<{ value: number; withoutValue: number; otherCurrency: number }> {
    // The cart value is a decimal string inside the saved cart (see abandonmentDerivedWhere): summed in the database, never cast unless it is a plain number.
    const num_ = Prisma.sql`(CASE WHEN a.cart_snapshot->>'cartValue' ~ '^[0-9]+([.][0-9]+)?$' THEN (a.cart_snapshot->>'cartValue')::numeric END)`;
    const inr = Prisma.sql`(a.cart_snapshot->>'currency' IS NULL OR a.cart_snapshot->>'currency' = '' OR upper(a.cart_snapshot->>'currency') = 'INR')`;
    const scope = abandonmentLeadScope(user);
    const manager = Object.keys(scope).length > 0 ? Prisma.sql`AND l.assigned_manager_id = ${user.id}::uuid` : Prisma.empty;
    const notConverted = ids.converted.length > 0 ? Prisma.sql`AND a.id::text <> ALL(${[...ids.converted]}::text[])` : Prisma.empty;
    const rows = await this.db.$queryRaw<{ value: Prisma.Decimal | null; without_value: bigint; other_currency: bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM(CASE WHEN ${inr} THEN ${num_} END), 0) AS value,
             COUNT(*) FILTER (WHERE ${num_} IS NULL) AS without_value,
             COUNT(*) FILTER (WHERE NOT ${inr}) AS other_currency
      FROM abandonments a JOIN leads l ON l.id = a.lead_id
      WHERE a.type = 'CHECKOUT'::abandonment_type AND a.detected_at >= ${range.start} AND a.detected_at < ${range.end}
        AND a.status IN ('ACTIVE'::abandonment_status, 'IN_PROGRESS'::abandonment_status) ${manager} ${notConverted}`);
    const r = rows[0];
    return { value: r?.value ? Number(r.value.toString()) : 0, withoutValue: Number(r?.without_value ?? 0), otherCurrency: Number(r?.other_currency ?? 0) };
  }

  /** Cards for the date range (always) and, when a card is clicked, its rows (one page). */
  async overview(user: AuthUser, f: AbandonedFilters, page: number, pageSize: number) {
    this.assertAllowed(user);
    const range = resolveDashboardRange(f, this.now());
    const base = abandonedBaseWhere(user, range);
    const conv = await this.conversions(user, range);
    const of = (m: AbandonedMetric): Prisma.AbandonmentWhereInput => ({ AND: [base, abandonedMetricWhere(m, conv.ids)] });
    const [total, pending, done, recovered, open, latest, detected] = await Promise.all([
      this.db.abandonment.count({ where: of("TOTAL") }),
      this.db.abandonment.count({ where: of("PENDING") }),
      this.db.abandonment.count({ where: of("DONE") }),
      this.db.abandonment.count({ where: of("RECOVERED") }),
      this.openValue(user, range, conv.ids),
      this.db.abandonment.aggregate({ where: { type: AbandonmentType.CHECKOUT }, _max: { detectedAt: true }, _min: { detectedAt: true } }),
      this.db.abandonment.count({ where: base }),
    ]);
    const openCount = await this.db.abandonment.count({ where: of("VALUE") });
    // the checkouts the CRM holds start on `oldest`: a period before that is not a real zero
    const oldest = latest._min.detectedAt;
    const coverage: Coverage = coverageOf(range, oldest, latest._max.detectedAt);
    let comparison: null | { totalAbandoned: ReturnType<typeof compare> } = null;
    if (coverage === "FULL") {
      const prev = previousRange(range);
      const prevCoverage = coverageOf(prev, oldest, latest._max.detectedAt);
      if (prevCoverage === "FULL") comparison = { totalAbandoned: compare(total, await this.db.abandonment.count({ where: { AND: [abandonedBaseWhere(user, prev), abandonedMetricWhere("TOTAL", (await this.conversions(user, prev)).ids)] } }), coverage, prevCoverage) };
    }
    let details: null | { metric: AbandonedMetric; items: ReturnType<typeof mapAbandonedRow>[]; pagination: { page: number; pageSize: number; totalItems: number; totalPages: number } } = null;
    if (f.metric) {
      const where = this.detailsWhere(user, range, f, conv.ids);
      const [rows, totalItems] = await Promise.all([
        this.db.abandonment.findMany({ where, select: ROW_SELECT, orderBy: [{ detectedAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
        this.db.abandonment.count({ where }),
      ]);
      const finishedIds = await this.finishedSet(rows.map((r) => r.id));
      details = { metric: f.metric, items: rows.map((r) => mapAbandonedRow(r, finishedIds.has(r.id), conv.orders.get(r.id) ?? null)), pagination: { page, pageSize, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / pageSize)) } };
    }
    return {
      range: { kind: range.range, from: range.from, to: range.to, timezone: range.timezone, days: range.days },
      coverage,
      comparison,
      summary: { totalAbandoned: total, potentialValue: open.value, openCheckouts: openCount, followUpPending: pending, followUpCompleted: done, recovered, detected, conversion: this.conversionSummary(conv, detected), openWithoutValue: open.withoutValue, openOtherCurrency: open.otherCurrency },
      // what the data does and does not contain, so the page never implies more than it knows
      source: { name: "Shiprocket Checkout (Fastrr) abandon-cart events", paymentModeAvailable: false, latestCheckoutAt: latest._max.detectedAt },
      details,
    };
  }

  private detailsWhere(user: AuthUser, range: DashboardRange, f: AbandonedFilters, ids: ConvertedIds): Prisma.AbandonmentWhereInput {
    const and: Prisma.AbandonmentWhereInput[] = [abandonedBaseWhere(user, range)];
    if (f.metric) and.push(abandonedMetricWhere(f.metric, ids));
    if (f.search?.trim()) and.push(abandonmentSearchWhere(f.search.trim()));
    return { AND: and };
  }

  /** The checkouts of the range (in the viewer's visibility) that became a real order. Only the LINK is found here; eligibility, revenue and COD / prepaid use the Reports rules (see CONVERSION above). Read-only. */
  private async conversions(user: AuthUser, range: DashboardRange) {
    const scope = abandonmentLeadScope(user);
    const manager = Object.keys(scope).length > 0 ? Prisma.sql`AND l.assigned_manager_id = ${user.id}::uuid` : Prisma.empty;
    const links = await this.db.$queryRaw<{ abandonment_id: string; order_id: string }[]>(Prisma.sql`
      SELECT a.id::text AS abandonment_id, o.id::text AS order_id
      FROM abandonments a
      JOIN leads l ON l.id = a.lead_id
      JOIN orders o ON o.lead_id = a.lead_id AND o.metadata->'abandonment'->>'id' = a.id::text
      WHERE a.type = 'CHECKOUT'::abandonment_type AND a.detected_at >= ${range.start} AND a.detected_at < ${range.end} ${manager}
        AND o.source = 'SALESPERSON'::order_source`);
    const tally = emptySales();
    const out = { tally, awaitingPayment: 0, unclassified: 0, telecallers: [] as { id: string | null; name: string | null; cents: number }[], ids: { converted: [] as string[], cod: [] as string[], prepaid: [] as string[] }, orders: new Map<string, ConvertedOrder>() };
    if (links.length === 0) return out;
    const orders = await this.db.order.findMany({
      where: { id: { in: [...new Set(links.map((x) => x.order_id))] }, status: { in: SOLD_STATUSES } },
      select: {
        id: true, orderNumber: true, status: true, totalAmount: true, confirmedAt: true, placedAt: true, createdAt: true, createdById: true, confirmedByUserId: true,
        createdBy: { select: { name: true } }, confirmedBy: { select: { name: true } },
        payments: { select: { method: true, status: true, amount: true, refundedAmount: true } },
      },
    });
    const byId = new Map(orders.map((o) => [o.id, o]));
    const perCheckout = new Map<string, typeof orders>();
    for (const l of links) {
      const o = byId.get(l.order_id);
      if (o) perCheckout.set(l.abandonment_id, [...(perCheckout.get(l.abandonment_id) ?? []), o]);
    }
    const saleAt = (o: (typeof orders)[number]) => (o.confirmedAt ?? o.placedAt ?? o.createdAt).getTime();
    for (const [abandonmentId, list] of perCheckout) {
      let sale: { cents: number; collectedCents: number; mode: "COD" | "PREPAID"; o: (typeof orders)[number] } | null = null;
      let awaiting = false;
      let unclassified = false;
      for (const o of [...list].sort((x, y) => saleAt(x) - saleAt(y) || x.id.localeCompare(y.id))) {
        const breakdown = computePaymentBreakdown(o.payments);
        const cents = toCents(o.totalAmount.toString()) - breakdown.refundedCents;
        if (cents <= 0) continue;
        const mode = derivePaymentMode(o.payments);
        if (mode === null) unclassified = true;
        else if (mode === "PREPAID" && !VERIFIED_PAYMENT.includes(derivePaymentStatus(o.payments) as PaymentStatus)) awaiting = true; // verified = a SUCCESS payment (a partial refund keeps it a sale, net of the refund)
        else { sale = { cents, collectedCents: breakdown.paidCents, mode, o }; break; }
      }
      if (sale) {
        addSale(tally, sale);
        out.ids.converted.push(abandonmentId);
        (sale.mode === "COD" ? out.ids.cod : out.ids.prepaid).push(abandonmentId);
        const who = sale.o.confirmedByUserId ?? sale.o.createdById;
        const telecaller = sale.o.confirmedByUserId ? (sale.o.confirmedBy?.name ?? null) : (sale.o.createdBy?.name ?? null);
        out.telecallers.push({ id: who, name: telecaller, cents: sale.cents });
        out.orders.set(abandonmentId, { orderNumber: sale.o.orderNumber, mode: sale.mode, status: sale.o.status, paymentStatus: derivePaymentStatus(sale.o.payments), amount: sale.cents / 100, collected: sale.collectedCents / 100, telecaller });
      } else if (awaiting) out.awaitingPayment += 1;
      else if (unclassified) out.unclassified += 1;
    }
    return out;
  }

  private conversionSummary(c: Awaited<ReturnType<AbandonedDashboardService["conversions"]>>, detected: number) {
    const t = salesOut(c.tally);
    const byUser = new Map<string, { userId: string | null; name: string | null; converted: number; revenue: number }>();
    for (const x of c.telecallers) {
      const k = x.id ?? "none";
      const e = byUser.get(k) ?? { userId: x.id, name: x.name, converted: 0, revenue: 0 };
      e.converted += 1;
      e.revenue = Math.round(e.revenue * 100 + x.cents) / 100;
      byUser.set(k, e);
    }
    return {
      converted: t.orders,
      conversionRate: detected > 0 ? Math.round((t.orders / detected) * 10000) / 100 : null, // percent, 2 dp; null = nothing detected (not a real 0%)
      revenue: t.revenue,
      prepaid: { count: t.prepaidOrders, revenue: t.prepaidRevenue },
      cod: { count: t.codOrders, revenue: t.codRevenue },
      awaitingPayment: c.awaitingPayment,
      unclassified: c.unclassified,
      byTelecaller: [...byUser.values()].sort((a, b) => b.revenue - a.revenue),
    };
  }

  private async finishedSet(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db.recoveryAction.findMany({ where: { abandonmentId: { in: ids }, status: { in: FINISHED } }, select: { abandonmentId: true }, distinct: ["abandonmentId"] });
    return new Set(rows.map((r) => r.abandonmentId));
  }

  /**
   * Abandoned-checkouts trend for the SAME range as the cards: bars = abandoned checkouts per day / week / month (the Total Abandoned card; recovered carts are not abandoned), line = the cart value of those
   * still open (the Potential Abandoned Value card), in the viewer's own visibility. A bucket before the first checkout the CRM holds is `available: false`, not zero.
   */
  async chart(user: AuthUser, f: DashboardRangeInput, interval: Interval) {
    this.assertAllowed(user);
    if (!INTERVALS.includes(interval)) throw new ApiError("Unknown chart interval", STATUS_CODES.BAD_REQUEST);
    const range = resolveDashboardRange(f, this.now());
    const scope = abandonmentLeadScope(user);
    const manager = Object.keys(scope).length > 0 ? Prisma.sql`AND l.assigned_manager_id = ${user.id}::uuid` : Prisma.empty;
    const value = Prisma.sql`(CASE WHEN a.cart_snapshot->>'cartValue' ~ '^[0-9]+([.][0-9]+)?$' THEN (a.cart_snapshot->>'cartValue')::numeric END)`;
    const inr = Prisma.sql`(a.cart_snapshot->>'currency' IS NULL OR a.cart_snapshot->>'currency' = '' OR upper(a.cart_snapshot->>'currency') = 'INR')`;
    const rows = await this.db.$queryRaw<{ bucket: string; abandoned: number; open_value: Prisma.Decimal | null }[]>(Prisma.sql`
      SELECT to_char(date_trunc(${TRUNC_UNIT[interval]}, (a.detected_at AT TIME ZONE 'UTC') AT TIME ZONE ${range.timezone}), 'YYYY-MM-DD') AS bucket,
             COUNT(*) FILTER (WHERE a.status <> 'RECOVERED'::abandonment_status)::int AS abandoned,
             COALESCE(SUM(CASE WHEN a.status IN ('ACTIVE'::abandonment_status, 'IN_PROGRESS'::abandonment_status) AND ${inr} THEN ${value} END), 0) AS open_value
      FROM abandonments a JOIN leads l ON l.id = a.lead_id
      WHERE a.type = 'CHECKOUT'::abandonment_type AND a.detected_at >= ${range.start} AND a.detected_at < ${range.end} ${manager}
      GROUP BY 1`);
    const byKey = new Map(rows.map((r) => [r.bucket, { orders: Number(r.abandoned), revenue: Number(r.open_value?.toString() ?? 0) }]));
    const bounds = await this.db.abandonment.aggregate({ where: { type: AbandonmentType.CHECKOUT }, _min: { detectedAt: true }, _max: { detectedAt: true } });
    const buckets = bucketsFor(range, interval).map((b) => {
      const cov = coverageOf({ start: dayBounds(b.from, range.timezone).start, end: dayBounds(b.to, range.timezone).end }, bounds._min.detectedAt, bounds._max.detectedAt);
      const v = byKey.get(b.key);
      return { key: b.key, from: b.from, to: b.to, available: cov !== "NONE", partial: cov === "PARTIAL", abandoned: cov === "NONE" ? null : (v?.orders ?? 0), openValue: cov === "NONE" ? null : Math.round((v?.revenue ?? 0) * 100) / 100 };
    });
    return {
      range: { kind: range.range, from: range.from, to: range.to, timezone: range.timezone, days: range.days },
      interval,
      coverage: coverageOf(range, bounds._min.detectedAt, bounds._max.detectedAt),
      buckets,
      totals: { abandoned: buckets.reduce((s, b) => s + (b.abandoned ?? 0), 0), openValue: Math.round(buckets.reduce((s, b) => s + (b.openValue ?? 0), 0) * 100) / 100 },
    };
  }

  /** The clicked card's checkouts for the date range (and search) as an .xlsx file. */
  async exportXlsx(user: AuthUser, f: AbandonedFilters): Promise<{ buffer: Buffer; filename: string; rows: number; truncated: boolean }> {
    this.assertAllowed(user);
    const range = resolveDashboardRange(f, this.now());
    f = { ...f, metric: f.metric ?? "TOTAL" }; // an export with no card chosen is the abandoned checkouts (recovered carts are a purchase, so they are only exported from the Recovered card)
    const where = this.detailsWhere(user, range, f, (await this.conversions(user, range)).ids);
    const total = await this.db.abandonment.count({ where });
    const wb = new ExcelJS.Workbook();
    wb.creator = "AyushWellness CRM";
    const sheet = wb.addWorksheet("Abandoned checkouts", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = [
      { header: "Checkout date", key: "date", width: 20 },
      { header: "Customer", key: "customer", width: 26 },
      { header: "Phone", key: "phone", width: 16 },
      { header: "Email", key: "email", width: 28 },
      { header: "Amount", key: "amount", width: 14 },
      { header: "Items", key: "items", width: 36 },
      { header: "Stage", key: "stage", width: 16 },
      { header: "Checkout link", key: "link", width: 40 },
      { header: "Status", key: "status", width: 14 },
      { header: "Follow-up", key: "followUp", width: 14 },
      { header: "Assigned to", key: "assignedTo", width: 20 },
    ];
    sheet.getRow(1).font = { bold: true };
    let written = 0;
    let cursor: string | undefined;
    while (written < MAX_ABANDONED_EXPORT_ROWS) {
      const batch = await this.db.abandonment.findMany({ where, select: ROW_SELECT, orderBy: [{ detectedAt: "desc" }, { id: "desc" }], take: Math.min(500, MAX_ABANDONED_EXPORT_ROWS - written), ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      if (batch.length === 0) break;
      const finished = await this.finishedSet(batch.map((b) => b.id));
      for (const o of batch.map((b) => mapAbandonedRow(b, finished.has(b.id)))) {
        const row = sheet.addRow({ date: o.checkoutDate, customer: safeCell(o.customerName), phone: safeCell(o.phone ?? ""), email: safeCell(o.email ?? ""), amount: o.amount, items: safeCell(o.items.join(", ")), stage: safeCell(o.stage ?? ""), link: safeCell(o.checkoutLink ?? ""), status: o.status, followUp: o.followUp, assignedTo: safeCell(o.assignedTo ?? "") });
        row.getCell("date").numFmt = "dd mmm yyyy hh:mm";
        row.getCell("amount").numFmt = '"₹"#,##0.00';
        written++;
      }
      cursor = batch[batch.length - 1]!.id;
      if (batch.length < 500) break;
    }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, written + 1), column: 11 } };
    const summary = (await this.overview(user, f, 1, 1)).summary;
    const s = wb.addWorksheet("Summary");
    s.columns = [{ header: "Item", key: "k", width: 36 }, { header: "Value", key: "v", width: 36 }];
    s.getRow(1).font = { bold: true };
    for (const [k, v] of [
      ["Date range (by checkout time)", range.from === range.to ? range.from : `${range.from} to ${range.to}`],
      ["Timezone", range.timezone],
      ["Card clicked", f.metric ?? "TOTAL"],
      ["Search", f.search ?? ""],
      ["Total abandoned checkouts", summary.totalAbandoned],
      ["Potential abandoned value (open carts, INR)", summary.potentialValue],
      ["Follow-up pending", summary.followUpPending],
      ["Follow-up completed", summary.followUpCompleted],
      ["Recovered (purchase completed, not counted above)", summary.recovered],
      ["Rows in the sheet", written],
    ] as [string, string | number][]) s.addRow({ k, v: typeof v === "string" ? safeCell(v) : v });
    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: `Abandoned_Checkouts${f.metric ? `_${f.metric.toLowerCase()}` : ""}_${range.from}${range.from === range.to ? "" : `_to_${range.to}`}.xlsx`, rows: written, truncated: total > written };
  }
}

export default AbandonedDashboardService;
