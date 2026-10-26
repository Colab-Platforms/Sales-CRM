import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role } from "../../../generated/prisma/enums.js";
import { safeCell } from "../report-automation/report-automation.xlsx.js";
import { compare, INTERVALS, type Interval } from "./orders.dashboard.insights.js";
import { previousRange, resolveDashboardRange, type DashboardRange, type DashboardRangeInput } from "./orders.dashboard.range.js";
import { MAX_EXPORT_ROWS, MAX_PAGE_SIZE, type DashboardFilters } from "./orders.dashboard.service.js";
import { chartBuckets, filterOrders, matchesMetric, summarize, toRow } from "./orders.dashboard.live.metrics.js";
import { LiveWebsiteOrders, type LiveFetch } from "./orders.dashboard.live.source.js";

// WEBSITE ORDERS DASHBOARD - LIVE FROM SHOPIFY. Same endpoints, same response shape as the database-backed dashboard, but every figure comes from the orders Shopify itself holds for the selected range
// (see orders.dashboard.live.source.ts). Nothing is imported or stored: this service writes nothing, and the abandoned-checkout dashboard keeps its own source. When Shopify cannot be read the request FAILS
// with a clear message - it never answers with zeros.

/** Above this many website orders the previous-period comparison is not read (it would double the load time). */
export const COMPARISON_MAX_ORDERS = 1500;

const liveBlock = (f: LiveFetch) => ({
  source: "SHOPIFY_LIVE" as const,
  fetchedAt: f.fetchedAt,
  shopifyOrders: f.shopifyOrders,
  shopifyCount: f.shopifyCount,
  websiteOrders: f.orders.length,
  telecallerExcluded: f.telecallerExcluded,
  pages: f.pages,
  warnings: f.warnings,
});

export class LiveWebsiteDashboardService {
  constructor(
    private readonly source: LiveWebsiteOrders = new LiveWebsiteOrders({ db: prisma }),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private assertAllowed(user: Pick<AuthUser, "role">): void {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
  }

  private range(f: DashboardRangeInput): DashboardRange {
    return resolveDashboardRange(f, this.now());
  }

  private load(range: DashboardRange): Promise<LiveFetch> {
    return this.source.fetch({ start: range.start, end: range.end, timezone: range.timezone });
  }

  async overview(user: AuthUser, f: DashboardFilters, page: number, pageSize: number) {
    this.assertAllowed(user);
    const range = this.range(f);
    const live = await this.load(range);
    const summary = summarize(live.orders);

    // Comparison with the equal-length period just before, only when that period could be read in full too; otherwise none (never a made-up baseline).
    let comparison: null | { totalOrders: ReturnType<typeof compare>; totalValue: ReturnType<typeof compare> } = null;
    try {
      // a large range would double the Shopify reads (about a second per 100 orders), so only ranges up to COMPARISON_MAX_ORDERS are compared
      if (live.orders.length > COMPARISON_MAX_ORDERS) throw new Error("range too large to compare");
      const prev = summarize((await this.load(previousRange(range))).orders);
      comparison = { totalOrders: compare(summary.totalOrders, prev.totalOrders, "FULL", "FULL"), totalValue: compare(summary.totalValue, prev.totalValue, "FULL", "FULL") };
    } catch {
      comparison = null;
    }

    let details = null;
    if (f.metric) {
      const size = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
      const matching = filterOrders(live.orders, { metric: f.metric, search: f.search, paymentStatus: f.paymentStatus, fulfilment: f.fulfilment });
      const totalPages = Math.max(1, Math.ceil(matching.length / size));
      details = {
        metric: f.metric,
        section: "WEBSITE" as const,
        // the telecaller tab belongs to the other dashboard: shown as the number of telecaller orders left out of this range
        sections: { website: live.orders.filter((o) => matchesMetric(o, f.metric!)).length, telecaller: live.telecallerExcluded, other: 0 },
        items: matching.slice((page - 1) * size, page * size).map(toRow),
        pagination: { page, pageSize: size, totalItems: matching.length, totalPages },
      };
    }
    const newest = live.orders[0]?.createdAt ?? null;
    return {
      range: { kind: range.range, from: range.from, to: range.to, timezone: range.timezone, days: range.days },
      coverage: "FULL" as const, // the range was read in full from Shopify (a failed or oversized read is an error, not a partial answer)
      verification: null,
      comparison,
      summary,
      freshness: { latestWebsiteOrderAt: newest, websiteMayBeIncomplete: false, shopifyWebhooksReceived: 0, lastShopifyWebhookAt: null },
      live: liveBlock(live),
      details,
    };
  }

  async chart(user: AuthUser, f: DashboardRangeInput, interval: Interval) {
    this.assertAllowed(user);
    if (!INTERVALS.includes(interval)) throw new ApiError("Unknown chart interval", STATUS_CODES.BAD_REQUEST);
    const range = this.range(f);
    const live = await this.load(range);
    const buckets = chartBuckets(live.orders, range, interval);
    const summary = summarize(live.orders);
    return {
      range: { kind: range.range, from: range.from, to: range.to, timezone: range.timezone, days: range.days },
      interval,
      coverage: "FULL" as const,
      verification: null,
      live: liveBlock(live),
      buckets,
      // the buckets add up to the Total Orders / Total Order Value cards exactly
      totals: { orders: summary.totalOrders, revenue: summary.totalValue },
    };
  }

  async exportXlsx(user: AuthUser, f: DashboardFilters): Promise<{ buffer: Buffer; filename: string; rows: number; truncated: boolean }> {
    this.assertAllowed(user);
    const range = this.range(f);
    const live = await this.load(range);
    const matching = filterOrders(live.orders, { metric: f.metric, search: f.search, paymentStatus: f.paymentStatus, fulfilment: f.fulfilment });
    const rows = matching.slice(0, MAX_EXPORT_ROWS).map(toRow);
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
    ];
    sheet.getRow(1).font = { bold: true };
    for (const o of rows) {
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
      });
      row.getCell("orderDate").numFmt = "dd mmm yyyy hh:mm";
      row.getCell("totalAmount").numFmt = '"₹"#,##0.00';
    }
    const s = summarize(live.orders);
    const summary = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
    summary.columns = [{ header: "Item", key: "k", width: 36 }, { header: "Value", key: "v", width: 40 }];
    summary.getRow(1).font = { bold: true };
    for (const [k, v] of [
      ["Source", "Shopify (live read, not stored in the CRM)"],
      ["Fetched at", live.fetchedAt.toISOString()],
      ["Date range", range.from === range.to ? range.from : `${range.from} to ${range.to}`],
      ["Timezone", range.timezone],
      ["Card clicked", f.metric ?? "none (all orders)"],
      ["Search", f.search ?? ""],
      ["Payment status filter", f.paymentStatus ?? ""],
      ["Fulfilment filter", f.fulfilment ?? ""],
      ["Telecaller orders left out", live.telecallerExcluded],
      ["Total orders", s.totalOrders],
      ["Total order value (excl. cancelled)", s.totalValue],
      ["COD", s.cod],
      ["Prepaid", s.prepaid],
      ["Paid", s.paid],
      ["Pending payment", s.pendingPayment],
      ["Cancelled", s.cancelled],
      ["Fulfilled", s.fulfilled],
      ["Rows in the Orders sheet", rows.length],
      ...live.warnings.map((w): [string, string] => ["Warning", w]),
    ] as [string, string | number][]) summary.addRow({ k, v: typeof v === "string" ? safeCell(v) : v });
    const label = f.metric ? `_${f.metric.toLowerCase()}` : "";
    return {
      buffer: Buffer.from(await wb.xlsx.writeBuffer()),
      filename: `Orders_Website${label}_${range.from}${range.from === range.to ? "" : `_to_${range.to}`}.xlsx`,
      rows: rows.length,
      truncated: matching.length > rows.length,
    };
  }
}

export default LiveWebsiteDashboardService;
