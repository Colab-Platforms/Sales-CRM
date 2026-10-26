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
//   COD / prepaid is NOT shown: an abandoned-checkout event carries no payment mode, so there is nothing true to report.
// WHO SEES WHAT: the existing abandoned-lead visibility - an Admin sees every checkout, a Manager the ones assigned to them (abandonmentLeadScope).

export type AbandonedMetric = "TOTAL" | "VALUE" | "PENDING" | "DONE" | "RECOVERED";
export const ABANDONED_METRICS: readonly AbandonedMetric[] = ["TOTAL", "VALUE", "PENDING", "DONE", "RECOVERED"];

export interface AbandonedFilters extends DashboardRangeInput {
  metric?: AbandonedMetric;
  search?: string;
}

export const MAX_ABANDONED_PAGE_SIZE = 100;
export const MAX_ABANDONED_EXPORT_ROWS = 20_000;

const OPEN = [AbandonmentStatus.ACTIVE, AbandonmentStatus.IN_PROGRESS];
const FINISHED = [RecoveryActionStatus.SUCCESS, RecoveryActionStatus.FAILED];
const notRecovered: Prisma.AbandonmentWhereInput = { status: { not: AbandonmentStatus.RECOVERED } };
const finishedAction: Prisma.AbandonmentWhereInput = { recoveryActions: { some: { status: { in: FINISHED } } } };

/** The definition of each card: its number and the rows behind it come from this one clause. */
export function abandonedMetricWhere(metric: AbandonedMetric): Prisma.AbandonmentWhereInput {
  switch (metric) {
    case "TOTAL":
      return notRecovered;
    case "VALUE":
      return { status: { in: OPEN } };
    case "PENDING":
      return { AND: [notRecovered, { NOT: finishedAction }] };
    case "DONE":
      return { AND: [notRecovered, finishedAction] };
    case "RECOVERED":
      return { status: AbandonmentStatus.RECOVERED };
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

export const mapAbandonedRow = (o: Row, finished: boolean) => {
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

  private async openValue(user: AuthUser, range: DashboardRange): Promise<{ value: number; withoutValue: number; otherCurrency: number }> {
    // The cart value is a decimal string inside the saved cart (see abandonmentDerivedWhere): summed in the database, never cast unless it is a plain number.
    const num_ = Prisma.sql`(CASE WHEN a.cart_snapshot->>'cartValue' ~ '^[0-9]+([.][0-9]+)?$' THEN (a.cart_snapshot->>'cartValue')::numeric END)`;
    const inr = Prisma.sql`(a.cart_snapshot->>'currency' IS NULL OR a.cart_snapshot->>'currency' = '' OR upper(a.cart_snapshot->>'currency') = 'INR')`;
    const scope = abandonmentLeadScope(user);
    const manager = Object.keys(scope).length > 0 ? Prisma.sql`AND l.assigned_manager_id = ${user.id}::uuid` : Prisma.empty;
    const rows = await this.db.$queryRaw<{ value: Prisma.Decimal | null; without_value: bigint; other_currency: bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM(CASE WHEN ${inr} THEN ${num_} END), 0) AS value,
             COUNT(*) FILTER (WHERE ${num_} IS NULL) AS without_value,
             COUNT(*) FILTER (WHERE NOT ${inr}) AS other_currency
      FROM abandonments a JOIN leads l ON l.id = a.lead_id
      WHERE a.type = 'CHECKOUT'::abandonment_type AND a.detected_at >= ${range.start} AND a.detected_at < ${range.end}
        AND a.status IN ('ACTIVE'::abandonment_status, 'IN_PROGRESS'::abandonment_status) ${manager}`);
    const r = rows[0];
    return { value: r?.value ? Number(r.value.toString()) : 0, withoutValue: Number(r?.without_value ?? 0), otherCurrency: Number(r?.other_currency ?? 0) };
  }

  /** Cards for the date range (always) and, when a card is clicked, its rows (one page). */
  async overview(user: AuthUser, f: AbandonedFilters, page: number, pageSize: number) {
    this.assertAllowed(user);
    const range = resolveDashboardRange(f, this.now());
    const base = abandonedBaseWhere(user, range);
    const of = (m: AbandonedMetric): Prisma.AbandonmentWhereInput => ({ AND: [base, abandonedMetricWhere(m)] });
    const [total, pending, done, recovered, open, latest] = await Promise.all([
      this.db.abandonment.count({ where: of("TOTAL") }),
      this.db.abandonment.count({ where: of("PENDING") }),
      this.db.abandonment.count({ where: of("DONE") }),
      this.db.abandonment.count({ where: of("RECOVERED") }),
      this.openValue(user, range),
      this.db.abandonment.aggregate({ where: { type: AbandonmentType.CHECKOUT }, _max: { detectedAt: true }, _min: { detectedAt: true } }),
    ]);
    const openCount = await this.db.abandonment.count({ where: of("VALUE") });
    // the checkouts the CRM holds start on `oldest`: a period before that is not a real zero
    const oldest = latest._min.detectedAt;
    const coverage: Coverage = coverageOf(range, oldest, latest._max.detectedAt);
    let comparison: null | { totalAbandoned: ReturnType<typeof compare> } = null;
    if (coverage === "FULL") {
      const prev = previousRange(range);
      const prevCoverage = coverageOf(prev, oldest, latest._max.detectedAt);
      if (prevCoverage === "FULL") comparison = { totalAbandoned: compare(total, await this.db.abandonment.count({ where: { AND: [abandonedBaseWhere(user, prev), abandonedMetricWhere("TOTAL")] } }), coverage, prevCoverage) };
    }
    let details: null | { metric: AbandonedMetric; items: ReturnType<typeof mapAbandonedRow>[]; pagination: { page: number; pageSize: number; totalItems: number; totalPages: number } } = null;
    if (f.metric) {
      const where = this.detailsWhere(user, range, f);
      const [rows, totalItems] = await Promise.all([
        this.db.abandonment.findMany({ where, select: ROW_SELECT, orderBy: [{ detectedAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
        this.db.abandonment.count({ where }),
      ]);
      const finishedIds = await this.finishedSet(rows.map((r) => r.id));
      details = { metric: f.metric, items: rows.map((r) => mapAbandonedRow(r, finishedIds.has(r.id))), pagination: { page, pageSize, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / pageSize)) } };
    }
    return {
      range: { kind: range.range, from: range.from, to: range.to, timezone: range.timezone, days: range.days },
      coverage,
      comparison,
      summary: { totalAbandoned: total, potentialValue: open.value, openCheckouts: openCount, followUpPending: pending, followUpCompleted: done, recovered, openWithoutValue: open.withoutValue, openOtherCurrency: open.otherCurrency },
      // what the data does and does not contain, so the page never implies more than it knows
      source: { name: "Shiprocket Checkout (Fastrr) abandon-cart events", paymentModeAvailable: false, latestCheckoutAt: latest._max.detectedAt },
      details,
    };
  }

  private detailsWhere(user: AuthUser, range: DashboardRange, f: AbandonedFilters): Prisma.AbandonmentWhereInput {
    const and: Prisma.AbandonmentWhereInput[] = [abandonedBaseWhere(user, range)];
    if (f.metric) and.push(abandonedMetricWhere(f.metric));
    if (f.search?.trim()) and.push(abandonmentSearchWhere(f.search.trim()));
    return { AND: and };
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
    const where = this.detailsWhere(user, range, f);
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
