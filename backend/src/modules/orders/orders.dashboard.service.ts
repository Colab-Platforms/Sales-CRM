import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { OrderStatus, PaymentStatus, Role } from "../../../generated/prisma/enums.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { derivePaymentStatus, fullName, paymentStatusWhere, searchWhere } from "./orders.filters.js";
import { NO_PAYMENT } from "./orders.types.js";
import { previousRange, resolveDashboardRange, type DashboardRange, type DashboardRangeInput } from "./orders.dashboard.range.js";
import { bucketsFor, compare, coverageOf, INTERVALS, TRUNC_UNIT, verifiedCoverage, type Coverage, type Interval } from "./orders.dashboard.insights.js";
import { defaultShopifyOrderCounter, type ShopifyOrderCounter } from "./orders.dashboard.shopify-count.js";
import { safeCell } from "../report-automation/report-automation.xlsx.js";
import { dayBounds } from "../report-automation/report-automation.report.js";

/** Each bucket of a chart is checked against Shopify separately only up to this many buckets (one cheap count query each); beyond it only the whole range is checked. */
export const MAX_VERIFIED_BUCKETS = 62;
const dayStart = (date: string, tz: string) => dayBounds(date, tz).start;
/** Runs `fn` over `items` with at most `limit` in flight, keeping the order of the results. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}
const dayEnd = (date: string, tz: string) => dayBounds(date, tz).end;

// MANAGER / ADMIN ORDERS DASHBOARD. Read-only over the existing Order table - nothing is written, no Shopify call is made.
//
// WHERE AN ORDER CAME FROM (Order.source, set once when the row is created and never overwritten):
//   TELECALLER  = source SALESPERSON  - created in the CRM by a telecaller (Order.createdById is that person).
//   WEBSITE     = source SHOPIFY or WEBSITE - placed on the storefront and mirrored into the CRM by the Shopify sync / webhooks.
//   (API orders belong to neither section; they appear in "All orders" only.)
// NO DOUBLE COUNTING: a telecaller order that is later pushed to Shopify keeps its ONE row (the push stores the Shopify id on that same row, and the sync updates that row by (externalSource, externalId) - see
// shopify.persist.ts upsertOrder, which never changes `source` on update). So it stays a Telecaller order and is counted once; it is not also a Website order. Nothing here matches by name, phone or amount.
//
// DATE = Order.createdAt in the business timezone (see orders.dashboard.range.ts). DRAFT orders are not placed orders and are excluded everywhere.

export type Section = "ALL" | "WEBSITE" | "TELECALLER";
export type FulfilmentFilter = "UNFULFILLED" | "FULFILLED" | "CANCELLED" | "RETURNED";
export type PaymentFilter = "SUCCESS" | "PENDING" | "PROCESSING" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "NO_PAYMENT";

export interface DashboardFilters extends DashboardRangeInput {
  section?: Section;
  /** Raw Order.source, to narrow further inside a section. */
  source?: "SHOPIFY" | "WEBSITE" | "API" | "SALESPERSON";
  search?: string;
  paymentStatus?: PaymentFilter;
  fulfilment?: FulfilmentFilter;
  /** The summary card that was clicked: only the orders that make up that card's number. */
  metric?: Metric;
  /** WEBSITE = the Website Orders dashboard: cards, tab counts and rows are for orders placed on the storefront only (telecaller-created orders are never part of it). */
  scope?: "WEBSITE";
}

/** One value per summary card. */
export const METRICS = ["TOTAL", "VALUE", "COD", "PREPAID", "PAID", "PENDING", "CANCELLED", "FULFILLED"] as const;
export type Metric = (typeof METRICS)[number];

export const MAX_PAGE_SIZE = 100;
export const MAX_EXPORT_ROWS = 20_000;
const EXPORT_BATCH = 500;

const WEBSITE_SOURCES = ["SHOPIFY", "WEBSITE"] as const;
const FULFILMENT_STATUSES: Record<FulfilmentFilter, OrderStatus[]> = {
  UNFULFILLED: [OrderStatus.PENDING_PAYMENT, OrderStatus.CONFIRMED, OrderStatus.PROCESSING],
  FULFILLED: [OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED],
  CANCELLED: [OrderStatus.CANCELLED],
  RETURNED: [OrderStatus.RETURNED, OrderStatus.REFUNDED],
};

export const sectionOf = (source: string): "WEBSITE" | "TELECALLER" | "OTHER" => (source === "SALESPERSON" ? "TELECALLER" : (WEBSITE_SOURCES as readonly string[]).includes(source) ? "WEBSITE" : "OTHER");

export function fulfilmentOf(status: OrderStatus): FulfilmentFilter | "DRAFT" {
  if (status === OrderStatus.DRAFT) return "DRAFT";
  return (Object.keys(FULFILMENT_STATUSES) as FulfilmentFilter[]).find((k) => FULFILMENT_STATUSES[k].includes(status)) ?? "UNFULFILLED";
}

const sectionWhere = (section: Section | undefined): Prisma.OrderWhereInput => (section === "TELECALLER" ? { source: "SALESPERSON" } : section === "WEBSITE" ? { source: { in: [...WEBSITE_SOURCES] } } : {});

/** The ONE filter used by the cards, the tab counts, the list and the export, so they cannot disagree. `omit` leaves out a dimension (the tab counts ignore the section). */
export function dashboardWhere(f: DashboardFilters, range: DashboardRange, omit: { section?: boolean } = {}): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [{ createdAt: { gte: range.start, lt: range.end } }, { status: { not: OrderStatus.DRAFT } }];
  if (!omit.section) and.push(sectionWhere(f.section));
  if (f.source) and.push({ source: f.source });
  if (f.search?.trim()) and.push(searchWhere(f.search.trim()));
  if (f.paymentStatus) and.push(paymentStatusWhere(f.paymentStatus === "NO_PAYMENT" ? NO_PAYMENT : (f.paymentStatus as PaymentStatus)));
  if (f.fulfilment) and.push({ status: { in: FULFILMENT_STATUSES[f.fulfilment] } });
  if (f.metric) and.push(metricWhere(f.metric));
  return { AND: and };
}

const modeIs = (mode: "COD" | "PREPAID"): Prisma.OrderWhereInput => ({ metadata: { path: ["paymentMode"], equals: mode } });

/** The definition of each summary card. The card's NUMBER and the ROWS shown when it is clicked both come from this one clause, so they cannot disagree. */
export function metricWhere(metric: Metric): Prisma.OrderWhereInput {
  switch (metric) {
    case "TOTAL":
      return {};
    case "VALUE": // what the value card adds up: every order except cancelled ones
      return { status: { not: OrderStatus.CANCELLED } };
    case "COD":
      return modeIs("COD");
    case "PREPAID":
      return modeIs("PREPAID");
    case "PAID":
      return paymentStatusWhere(PaymentStatus.SUCCESS);
    case "PENDING":
      return { OR: [paymentStatusWhere(PaymentStatus.PENDING), paymentStatusWhere(PaymentStatus.PROCESSING), { status: OrderStatus.PENDING_PAYMENT }] };
    case "CANCELLED":
      return { status: OrderStatus.CANCELLED };
    case "FULFILLED":
      return { status: { in: FULFILMENT_STATUSES.FULFILLED } };
  }
}
const asMode = (metadata: unknown): "COD" | "PREPAID" | null => {
  const v = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).paymentMode : null;
  return v === "COD" || v === "PREPAID" ? v : null;
};

const ROW_SELECT = {
  id: true,
  orderNumber: true,
  externalNumber: true,
  createdAt: true,
  totalAmount: true,
  currency: true,
  status: true,
  source: true,
  metadata: true,
  lead: { select: { firstName: true, lastName: true, mobile: true } },
  createdBy: { select: { name: true } },
  payments: { select: { status: true } },
} satisfies Prisma.OrderSelect;
type Row = Prisma.OrderGetPayload<{ select: typeof ROW_SELECT }>;

export const mapRow = (o: Row) => ({
  id: o.id,
  // what staff recognise: the Shopify number (#1234) when there is one, else the CRM number
  orderId: o.externalNumber ?? o.orderNumber,
  orderNumber: o.orderNumber,
  orderDate: o.createdAt,
  customerName: fullName(o.lead.firstName, o.lead.lastName),
  phone: o.lead.mobile,
  totalAmount: Number(o.totalAmount),
  currency: o.currency,
  paymentMethod: asMode(o.metadata),
  paymentStatus: derivePaymentStatus(o.payments),
  orderStatus: o.status,
  fulfilmentStatus: fulfilmentOf(o.status),
  source: o.source,
  section: sectionOf(o.source),
  telecallerName: o.source === "SALESPERSON" ? (o.createdBy?.name ?? null) : null,
});

export class OrdersDashboardService {
  constructor(
    private readonly db: DbClient = prisma,
    private readonly now: () => Date = () => new Date(),
    private readonly shopifyCount: ShopifyOrderCounter = defaultShopifyOrderCounter,
  ) {}

  /** Orders the CRM holds that carry a Shopify id (storefront orders AND telecaller orders pushed to Shopify) - the number comparable with Shopify's own count for the period. */
  private crmShopifyCount(range: { start: Date; end: Date }): Promise<number> {
    return this.db.order.count({ where: { createdAt: { gte: range.start, lt: range.end }, externalSource: "SHOPIFY", status: { not: OrderStatus.DRAFT } } });
  }

  private assertAllowed(user: Pick<AuthUser, "role">): void {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
  }

  range(f: DashboardRangeInput): DashboardRange {
    return resolveDashboardRange(f, this.now());
  }

  /**
   * The SUMMARY CARDS for the selected date range (always, and independent of any section / filter / clicked card), and - only when a card has been clicked (`f.metric`) - the ORDER DETAILS for that card:
   * the tab counts (website / telecaller, for the range and that card) and one page of rows for the chosen section and filters. With no metric no order rows are read at all.
   */
  async overview(user: AuthUser, f: DashboardFilters, page: number, pageSize: number) {
    this.assertAllowed(user);
    const range = this.range(f);
    if (f.scope === "WEBSITE") f = { ...f, section: "WEBSITE" };
    const base = dashboardWhere({ section: f.scope === "WEBSITE" ? "WEBSITE" : undefined }, range); // the range (and, for the Website dashboard, the website source) alone: every placed, non-draft order in it
    const of = (metric: Metric): Prisma.OrderWhereInput => ({ AND: [base, metricWhere(metric)] });
    const [total, value, cancelledAgg, cod, prepaid, paid, pending, cancelled, fulfilled, latestWebsite, webhooks] = await Promise.all([
      this.db.order.count({ where: of("TOTAL") }),
      this.db.order.aggregate({ where: of("VALUE"), _sum: { totalAmount: true } }),
      this.db.order.aggregate({ where: of("CANCELLED"), _sum: { totalAmount: true } }),
      this.db.order.count({ where: of("COD") }),
      this.db.order.count({ where: of("PREPAID") }),
      this.db.order.count({ where: of("PAID") }),
      this.db.order.count({ where: of("PENDING") }),
      this.db.order.count({ where: of("CANCELLED") }),
      this.db.order.count({ where: of("FULFILLED") }),
      this.db.order.aggregate({ where: { source: { in: [...WEBSITE_SOURCES] } }, _max: { createdAt: true } }),
      // has this CRM EVER received a Shopify webhook, and when was the last one? (the live feed that keeps website orders current)
      this.db.webhookEvent.aggregate({ where: { provider: "SHOPIFY" }, _count: { _all: true }, _max: { receivedAt: true } }),
    ]);
    // How much of the selected period the CRM's synced website orders can speak for. A period the feed has not reached is UNAVAILABLE - never a real zero.
    const websiteOnly = f.scope === "WEBSITE";
    const oldestWebsite = websiteOnly ? await this.db.order.aggregate({ where: { source: { in: [...WEBSITE_SOURCES] } }, _min: { createdAt: true } }) : null;
    const newestOrder = latestWebsite._max.createdAt;
    const lastWebhook = webhooks._max.receivedAt;
    // The first/last-record check alone cannot see a hole in the middle of the history, so a website period is checked against Shopify's own count for it.
    const [shopifyTotal, crmTotal] = websiteOnly ? await Promise.all([this.shopifyCount(range.start, range.end), this.crmShopifyCount(range)]) : [null, 0];
    // Revenue split and collected money for the SAME selection as the other cards: the value card's rule (cancelled orders excluded), split by the order's recorded payment mode; collected = money received
    // (SUCCESS payments, and PARTIALLY_REFUNDED ones net of what was refunded - the Reports' own definition of "paid").
    const notCancelled: Prisma.OrderWhereInput = { status: { not: OrderStatus.CANCELLED } };
    const [codRev, prepaidRev, paidFull, paidPartial] = await Promise.all([
      this.db.order.aggregate({ where: { AND: [of("COD"), notCancelled] }, _sum: { totalAmount: true } }),
      this.db.order.aggregate({ where: { AND: [of("PREPAID"), notCancelled] }, _sum: { totalAmount: true } }),
      this.db.payment.aggregate({ where: { status: PaymentStatus.SUCCESS, order: of("TOTAL") }, _sum: { amount: true } }),
      this.db.payment.aggregate({ where: { status: PaymentStatus.PARTIALLY_REFUNDED, order: of("TOTAL") }, _sum: { amount: true, refundedAmount: true } }),
    ]);
    const collected = Number(paidFull._sum.amount ?? 0) + Number(paidPartial._sum.amount ?? 0) - Number(paidPartial._sum.refundedAmount ?? 0);
    const coverage: Coverage = websiteOnly ? verifiedCoverage(crmTotal, shopifyTotal, coverageOf(range, oldestWebsite!._min.createdAt, newestOrder, lastWebhook)) : "FULL";
    // card comparison text exists only when BOTH this period and the one before it are fully covered
    let comparison: null | { totalOrders: ReturnType<typeof compare>; totalValue: ReturnType<typeof compare> } = null;
    if (websiteOnly && coverage === "FULL") {
      const prev = previousRange(range);
      const [prevShopify, prevCrm] = await Promise.all([this.shopifyCount(prev.start, prev.end), this.crmShopifyCount(prev)]);
      const prevCoverage = verifiedCoverage(prevCrm, prevShopify, coverageOf(prev, oldestWebsite!._min.createdAt, newestOrder, lastWebhook));
      if (prevCoverage === "FULL") {
        const prevBase = dashboardWhere({ section: "WEBSITE" }, prev);
        const [prevCount, prevValue] = await Promise.all([this.db.order.count({ where: prevBase }), this.db.order.aggregate({ where: { AND: [prevBase, metricWhere("VALUE")] }, _sum: { totalAmount: true } })]);
        comparison = { totalOrders: compare(total, prevCount, coverage, prevCoverage), totalValue: compare(Number(value._sum.totalAmount ?? 0), Number(prevValue._sum.totalAmount ?? 0), coverage, prevCoverage) };
      }
    }
    let details: null | {
      metric: Metric;
      section: Section;
      sections: { website: number; telecaller: number; other: number };
      items: ReturnType<typeof mapRow>[];
      pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
    } = null;
    if (f.metric) {
      const metric = f.metric;
      const where = dashboardWhere(f, range);
      const [rows, matching, website, telecaller, anySection] = await Promise.all([
        this.db.order.findMany({ where, select: ROW_SELECT, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
        this.db.order.count({ where }),
        // tab counts: this date range + this card only (not the search / filters), so switching tabs shows what each tab would hold
        this.db.order.count({ where: { AND: [of(metric), sectionWhere("WEBSITE")] } }),
        this.db.order.count({ where: { AND: [of(metric), sectionWhere("TELECALLER")] } }),
        this.db.order.count({ where: of(metric) }),
      ]);
      details = {
        metric,
        section: f.section ?? "ALL",
        // API-sourced orders are in the cards but belong to neither tab
        sections: { website, telecaller, other: anySection - website - telecaller },
        items: rows.map(mapRow),
        pagination: { page, pageSize, totalItems: matching, totalPages: Math.max(1, Math.ceil(matching / pageSize)) },
      };
    }
    return {
      range: { kind: range.range, from: range.from, to: range.to, timezone: range.timezone, days: range.days },
      coverage,
      // what the CRM holds against what Shopify itself reports for the period (null count = Shopify could not be asked, so nothing is claimed complete)
      verification: websiteOnly ? { shopifyCount: shopifyTotal, crmCount: crmTotal, verified: shopifyTotal !== null } : null,
      comparison,
      summary: {
        totalOrders: total,
        // placed value: every order in the selection except cancelled ones (cancelled value is shown on its own)
        totalValue: Number(value._sum.totalAmount ?? 0),
        cod,
        prepaid,
        paid,
        pendingPayment: pending,
        cancelled,
        cancelledValue: Number(cancelledAgg._sum.totalAmount ?? 0),
        fulfilled,
        codRevenue: Number(codRev._sum.totalAmount ?? 0),
        prepaidRevenue: Number(prepaidRev._sum.totalAmount ?? 0),
        collected,
      },
      // Website orders reach the CRM through the Shopify sync / webhooks: if the newest one is older than the selected range, later orders have not been synced yet
      freshness: {
        latestWebsiteOrderAt: latestWebsite._max.createdAt,
        websiteMayBeIncomplete: !latestWebsite._max.createdAt || latestWebsite._max.createdAt < range.end,
        shopifyWebhooksReceived: webhooks._count._all,
        lastShopifyWebhookAt: webhooks._max.receivedAt,
      },
      details,
    };
  }

  /**
   * Orders & Revenue chart for the Website Orders dashboard: per day / week / month in the business timezone, for the SAME range as the cards. Bars = orders placed (the Total Orders card, cancelled included),
   * line = order value excluding cancelled (the Total Order Value card), so the buckets add up to the cards exactly. Each bucket is checked against Shopify's own order count for it (when that can be asked):
   * a bucket the CRM did not import is `available: false` with no numbers - not zero - and one it imported only in part is `partial`. With more than MAX_VERIFIED_BUCKETS buckets only the whole range is checked.
   */
  async chart(user: AuthUser, f: DashboardRangeInput, interval: Interval) {
    this.assertAllowed(user);
    if (!INTERVALS.includes(interval)) throw new ApiError("Unknown chart interval", STATUS_CODES.BAD_REQUEST);
    const range = this.range(f);
    const rows = await this.db.$queryRaw<{ bucket: string; orders: number; revenue: Prisma.Decimal | null; with_id: number }[]>(Prisma.sql`
      SELECT to_char(date_trunc(${TRUNC_UNIT[interval]}, (created_at AT TIME ZONE 'UTC') AT TIME ZONE ${range.timezone}), 'YYYY-MM-DD') AS bucket,
             COUNT(*)::int AS orders,
             COALESCE(SUM(CASE WHEN status <> 'CANCELLED'::order_status THEN total_amount END), 0) AS revenue,
             COUNT(*) FILTER (WHERE external_source = 'SHOPIFY'::external_source)::int AS with_id
      FROM orders
      WHERE source IN ('SHOPIFY'::order_source, 'WEBSITE'::order_source) AND status <> 'DRAFT'::order_status AND created_at >= ${range.start} AND created_at < ${range.end}
      GROUP BY 1`);
    const byKey = new Map(rows.map((r) => [r.bucket, { orders: Number(r.orders), revenue: Number(r.revenue?.toString() ?? 0), withId: Number(r.with_id) }]));
    const [oldest, newest, hook] = await Promise.all([
      this.db.order.aggregate({ where: { source: { in: [...WEBSITE_SOURCES] } }, _min: { createdAt: true } }),
      this.db.order.aggregate({ where: { source: { in: [...WEBSITE_SOURCES] } }, _max: { createdAt: true } }),
      this.db.webhookEvent.aggregate({ where: { provider: "SHOPIFY" }, _max: { receivedAt: true } }),
    ]);
    const bucketList = bucketsFor(range, interval);
    // the CRM's Shopify-id count (storefront + pushed telecaller orders) per bucket is what is comparable with Shopify's count; the telecaller part is not in `byKey`, so it is counted straight from the table
    const verifyEach = bucketList.length <= MAX_VERIFIED_BUCKETS;
    const clipOf = (b: { from: string; to: string }) => ({ start: dayStart(b.from, range.timezone), end: dayEnd(b.to, range.timezone) });
    const checks = verifyEach
      ? await mapLimit(bucketList, 6, async (b) => {
          const clip = clipOf(b);
          const [shopify, crm] = await Promise.all([this.shopifyCount(clip.start, clip.end), this.crmShopifyCount(clip)]);
          return { shopify, crm };
        })
      : null;
    const [rangeShopify, rangeCrm] = await Promise.all([this.shopifyCount(range.start, range.end), this.crmShopifyCount(range)]);
    const rangeBounds = coverageOf(range, oldest._min.createdAt, newest._max.createdAt, hook._max.receivedAt);
    const rangeCoverage = verifiedCoverage(rangeCrm, rangeShopify, rangeBounds);
    const buckets = bucketList.map((b, i) => {
      const clip = clipOf(b);
      const v = byKey.get(b.key);
      const cov: Coverage = checks
        ? verifiedCoverage(checks[i]!.crm, checks[i]!.shopify, coverageOf(clip, oldest._min.createdAt, newest._max.createdAt, hook._max.receivedAt))
        : rangeCoverage === "FULL" ? "FULL" : (v?.withId ?? 0) > 0 ? "PARTIAL" : "NONE";
      return { key: b.key, from: b.from, to: b.to, available: cov !== "NONE", partial: cov === "PARTIAL", orders: cov === "NONE" ? null : (v?.orders ?? 0), revenue: cov === "NONE" ? null : Math.round((v?.revenue ?? 0) * 100) / 100 };
    });
    const totalOrders = buckets.reduce((s, b) => s + (b.orders ?? 0), 0);
    const totalRevenue = Math.round(buckets.reduce((s, b) => s + (b.revenue ?? 0), 0) * 100) / 100;
    return {
      range: { kind: range.range, from: range.from, to: range.to, timezone: range.timezone, days: range.days },
      interval,
      coverage: rangeCoverage,
      verification: { shopifyCount: rangeShopify, crmCount: rangeCrm, verified: rangeShopify !== null, perBucket: verifyEach },
      buckets,
      totals: { orders: totalOrders, revenue: totalRevenue },
    };
  }

  /** The same selection as an Excel workbook: a Summary sheet (range + filters + cards) and every matching order, read in batches. */
  async exportXlsx(user: AuthUser, f: DashboardFilters): Promise<{ buffer: Buffer; filename: string; rows: number; truncated: boolean }> {
    this.assertAllowed(user);
    const range = this.range(f);
    if (f.scope === "WEBSITE") f = { ...f, section: "WEBSITE" };
    const where = dashboardWhere(f, range);
    const total = await this.db.order.count({ where });
    const wb = new ExcelJS.Workbook();
    wb.creator = "AyushWellness CRM";
    const sheet = wb.addWorksheet("Orders", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = [
      { header: "Order ID", key: "orderId", width: 18 },
      { header: "Order date", key: "orderDate", width: 20 },
      { header: "Customer", key: "customerName", width: 26 },
      { header: "Phone", key: "phone", width: 16 },
      { header: "Total", key: "totalAmount", width: 14 },
      { header: "Payment method", key: "paymentMethod", width: 14 },
      { header: "Payment status", key: "paymentStatus", width: 18 },
      { header: "Fulfilment", key: "fulfilmentStatus", width: 14 },
      { header: "Order status", key: "orderStatus", width: 18 },
      { header: "Source", key: "source", width: 12 },
      { header: "Section", key: "section", width: 12 },
      { header: "Telecaller", key: "telecallerName", width: 22 },
    ];
    sheet.getRow(1).font = { bold: true };
    let written = 0;
    let cursor: string | undefined;
    while (written < MAX_EXPORT_ROWS) {
      const batch = await this.db.order.findMany({ where, select: ROW_SELECT, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: Math.min(EXPORT_BATCH, MAX_EXPORT_ROWS - written), ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      if (batch.length === 0) break;
      for (const o of batch.map(mapRow)) {
        const row = sheet.addRow({
          orderId: safeCell(o.orderId),
          orderDate: o.orderDate,
          customerName: safeCell(o.customerName),
          phone: safeCell(o.phone ?? ""),
          totalAmount: o.totalAmount,
          paymentMethod: o.paymentMethod ?? "",
          paymentStatus: o.paymentStatus ?? "NO_PAYMENT",
          fulfilmentStatus: o.fulfilmentStatus,
          orderStatus: o.orderStatus,
          source: o.source,
          section: o.section,
          telecallerName: safeCell(o.telecallerName ?? ""),
        });
        row.getCell("orderDate").numFmt = "dd mmm yyyy hh:mm";
        row.getCell("totalAmount").numFmt = '"₹"#,##0.00';
        written++;
      }
      cursor = batch[batch.length - 1]!.id;
      if (batch.length < EXPORT_BATCH) break;
    }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, written + 1), column: 12 } };
    const overview = await this.overview(user, f, 1, 1);
    const summary = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
    summary.columns = [{ header: "Item", key: "k", width: 30 }, { header: "Value", key: "v", width: 40 }];
    summary.getRow(1).font = { bold: true };
    const s = overview.summary;
    for (const [k, v] of [
      ["Date range", range.from === range.to ? range.from : `${range.from} to ${range.to}`],
      ["Timezone", range.timezone],
      ["Card clicked", f.metric ?? "none (all orders)"],
      ["Section", f.section ?? "ALL"],
      ["Search", f.search ?? ""],
      ["Payment status filter", f.paymentStatus ?? ""],
      ["Fulfilment filter", f.fulfilment ?? ""],
      ["Source filter", f.source ?? ""],
      ["Total orders", s.totalOrders],
      ["Total order value (excl. cancelled)", s.totalValue],
      ["COD", s.cod],
      ["Prepaid", s.prepaid],
      ["Paid", s.paid],
      ["Pending payment", s.pendingPayment],
      ["Cancelled", s.cancelled],
      ["Fulfilled", s.fulfilled],
      ["Rows in the Orders sheet", written],
    ] as [string, string | number][]) summary.addRow({ k, v: typeof v === "string" ? safeCell(v) : v });
    const label = f.section === "WEBSITE" ? "Website" : f.section === "TELECALLER" ? "Telecaller" : "All";
    return {
      buffer: Buffer.from(await wb.xlsx.writeBuffer()),
      filename: `Orders_${label}${f.metric ? `_${f.metric.toLowerCase()}` : ""}_${range.from}${range.from === range.to ? "" : `_to_${range.to}`}.xlsx`,
      rows: written,
      truncated: total > written,
    };
  }
}

export default OrdersDashboardService;
