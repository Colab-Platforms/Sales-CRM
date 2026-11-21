import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import { logger } from "@/utils/logger.js";
import { OrderStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { dayRecord, totalsOf, type SessionForDay } from "../attendance/attendance.records.js";
import { managerAnalyticsService } from "../manager/manager.analytics.js";
import LiveWebsiteDashboardService from "../orders/orders.dashboard.live.service.js";
import { aggregateLeads, aggregateMarketing, aggregateOrders, aggregatePayments, aggregateProducts, aggregateSales, mergeTelecallerWindows, rupees, teamTotals, toPaise, type CampaignFact, type LeadFact, type OrderFact, type PaymentFact, type TelecallerOut, type TelecallerWindowRow } from "./hrms.aggregate.js";
import { HrmsHttpError } from "./hrms.auth.js";
import { HRMS_TIMEZONE, IST_OFFSET_MINUTES, istDay, listDays, shiftDay, todayInIst, type HrmsRange } from "./hrms.range.js";

// THE HRMS REPORTING SERVICE. Read-only: nothing in this file writes. It loads only the columns a total needs - never a customer's name, phone, email, address or an order identifier - and hands them to the
// pure calculations in hrms.aggregate.ts. Every endpoint is made of independent SECTIONS: a section that cannot be calculated is null with an availability entry saying why, never a zero.

const PAGE = 2000;
/** The Reports' telecaller analytics read at most this many days at a time (see mergeTelecallerWindows). */
export const ANALYTICS_WINDOW_DAYS = 92;
const SERVICE_VIEWER = { id: "hrms-integration", role: Role.ADMIN, username: "hrms-integration" } as AuthUser;

export interface Availability {
  available: boolean;
  error: string | null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;
export interface Report<T> {
  data: T;
  availability: Record<string, Availability>;
  basis: Record<string, string>;
  /** Anything a reader must know that is not an error (limitations of the source data). */
  notes?: string[];
}

export interface WebsiteFigures {
  /** Website (Shopify storefront) orders, live from Shopify. */
  orders: number;
  revenueExcludingCancelled: number;
  cod: number;
  prepaid: number;
  otherPayment: number;
  cancelled: number;
  cancelledValue: number;
  /** Money Shopify records as received (a COD order only once Shopify marks it paid). */
  collected: number;
  /** Every Shopify order of the range, website plus the ones telecallers created in the CRM. */
  allShopifyOrders: number;
  telecallerCreatedOrders: number;
}

export interface HrmsDeps {
  db?: DbClient;
  now?: () => Date;
  /** The live Shopify website-order figures. Default: the Orders Dashboard's own service. */
  website?: (range: HrmsRange) => Promise<WebsiteFigures>;
  /** The Reports' telecaller figures for ONE window of at most ANALYTICS_WINDOW_DAYS days. Default: the manager analytics service. */
  telecallerWindow?: (from: string, to: string) => Promise<TelecallerWindowRow[]>;
}

/** Splits [from, to] into consecutive windows of at most `size` days. */
export function splitWindows(from: string, to: string, size = ANALYTICS_WINDOW_DAYS): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = shiftDay(cursor, size - 1);
    const last = end < to ? end : to;
    out.push({ from: cursor, to: last });
    cursor = shiftDay(last, 1);
  }
  return out;
}

const SAFE_ERROR = "This section could not be calculated right now.";
function describe(error: unknown): string {
  if (error instanceof HrmsHttpError || error instanceof ApiError) return error.message;
  // anything else may carry query text: log only its kind, tell the caller nothing internal
  logger.error(`HRMS section failed: ${error instanceof Error ? error.name : "unknown"}${(error as { code?: string })?.code ? ` ${(error as { code?: string }).code}` : ""}`);
  return SAFE_ERROR;
}

/** Runs each section on its own: one that fails is null + an availability entry, the others are unaffected. */
export async function runSections<S extends Record<string, () => Promise<unknown>>>(sections: S): Promise<{ data: { [K in keyof S]: Awaited<ReturnType<S[K]>> | null }; availability: Record<string, Availability> }> {
  const data: Record<string, unknown> = {};
  const availability: Record<string, Availability> = {};
  await Promise.all(
    Object.entries(sections).map(async ([name, run]) => {
      try {
        data[name] = await run();
        availability[name] = { available: true, error: null };
      } catch (error) {
        data[name] = null;
        availability[name] = { available: false, error: describe(error) };
      }
    }),
  );
  // keep the declared order in the JSON
  const ordered: Record<string, unknown> = {};
  for (const name of Object.keys(sections)) ordered[name] = data[name];
  return { data: ordered as never, availability };
}

async function pageAll<T extends { id: string }>(find: (args: { take: number; skip?: number; cursor?: { id: string }; orderBy: { id: "asc" } }) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await find({ take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: "asc" } });
    out.push(...rows);
    if (rows.length < PAGE) return out;
    cursor = rows[rows.length - 1]!.id;
  }
}

const ORDER_SELECT = {
  id: true,
  status: true,
  source: true,
  totalAmount: true,
  discountAmount: true,
  couponId: true,
  couponCode: true,
  confirmedAt: true,
  placedAt: true,
  createdAt: true,
  lead: { select: { sourceId: true } },
  payments: { select: { method: true, status: true, amount: true, refundedAmount: true } },
  items: { select: { productId: true, productNameSnapshot: true, skuSnapshot: true, quantity: true, totalPrice: true, itemType: true } },
} satisfies Prisma.OrderSelect;

export class HrmsReportingService {
  private readonly db: DbClient;
  private readonly now: () => Date;
  private readonly deps: HrmsDeps;

  constructor(deps: HrmsDeps = {}) {
    this.db = deps.db ?? prisma;
    this.now = deps.now ?? (() => new Date());
    this.deps = deps;
  }

  // ------------------------------------------------------------------------------------------------ source data

  /** The first IST day any CRM record exists for (all_time starts here); null when the CRM is empty. */
  async earliestDay(): Promise<string | null> {
    const [o, l, p, c] = await Promise.all([
      this.db.order.aggregate({ _min: { createdAt: true } }),
      this.db.lead.aggregate({ _min: { createdAt: true } }),
      this.db.payment.aggregate({ _min: { createdAt: true } }),
      this.db.call.aggregate({ _min: { createdAt: true } }),
    ]);
    const times = [o._min.createdAt, l._min.createdAt, p._min.createdAt, c._min.createdAt].filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
    return times.length > 0 ? istDay(new Date(Math.min(...times))) : null;
  }

  private async orderFacts(range: HrmsRange): Promise<OrderFact[]> {
    const inRange = { gte: range.start, lt: range.end };
    const where: Prisma.OrderWhereInput = {
      status: { not: OrderStatus.DRAFT },
      // the sale's business date: confirmedAt, else placedAt, else createdAt (the same rule the Reports use)
      OR: [{ confirmedAt: inRange }, { confirmedAt: null, placedAt: inRange }, { confirmedAt: null, placedAt: null, createdAt: inRange }],
    };
    const rows = await pageAll((args) => this.db.order.findMany({ where, select: ORDER_SELECT, ...args }));
    return rows.map((o) => ({
      at: o.confirmedAt ?? o.placedAt ?? o.createdAt,
      status: o.status,
      source: o.source,
      totalCents: toPaise(o.totalAmount),
      discountCents: toPaise(o.discountAmount),
      couponId: o.couponId,
      couponCode: o.couponCode,
      leadSourceId: o.lead?.sourceId ?? null,
      payments: o.payments.map((p) => ({ method: p.method, status: p.status, amountCents: toPaise(p.amount), refundedCents: toPaise(p.refundedAmount) })),
      items: o.items.map((i) => ({ productId: i.productId, name: i.productNameSnapshot, sku: i.skuSnapshot, units: i.quantity, totalCents: toPaise(i.totalPrice), custom: i.itemType === "CUSTOM" })),
    }));
  }

  private async paymentFacts(range: HrmsRange): Promise<PaymentFact[]> {
    const inRange = { gte: range.start, lt: range.end };
    const where: Prisma.PaymentWhereInput = { OR: [{ paidAt: inRange }, { refundedAt: inRange }, { failedAt: inRange }, { createdAt: inRange }] };
    const rows = await pageAll((args) => this.db.payment.findMany({ where, select: { id: true, status: true, method: true, provider: true, amount: true, refundedAmount: true, paidAt: true, failedAt: true, refundedAt: true, createdAt: true }, ...args }));
    return rows.map((p) => ({ status: p.status, method: p.method, provider: p.provider, amountCents: toPaise(p.amount), refundedCents: toPaise(p.refundedAmount), paidAt: p.paidAt, failedAt: p.failedAt, refundedAt: p.refundedAt, createdAt: p.createdAt }));
  }

  private async leadFacts(range: HrmsRange): Promise<LeadFact[]> {
    const where: Prisma.LeadWhereInput = { createdAt: { gte: range.start, lt: range.end } };
    const rows = await pageAll((args) => this.db.lead.findMany({ where, select: { id: true, createdAt: true, workingStatus: true, lifecycleStage: true, ownerId: true, sourceId: true, lastContactedAt: true }, ...args }));
    return rows.map((l) => ({ createdAt: l.createdAt, workingStatus: l.workingStatus, lifecycleStage: l.lifecycleStage, ownerId: l.ownerId, sourceId: l.sourceId, contacted: l.lastContactedAt !== null }));
  }

  private async sources() {
    return this.db.source.findMany({ select: { id: true, name: true, type: true }, orderBy: { name: "asc" } });
  }

  private async campaignFacts(range: HrmsRange): Promise<CampaignFact[]> {
    const inRange = { gte: range.start, lt: range.end };
    const campaigns = await this.db.whatsAppCampaign.findMany({
      where: { OR: [{ startedAt: inRange }, { startedAt: null, scheduledAt: inRange }, { startedAt: null, scheduledAt: null, createdAt: inRange }] },
      select: { id: true, name: true, status: true, startedAt: true, scheduledAt: true, createdAt: true, completedAt: true, recipientCount: true },
    });
    if (campaigns.length === 0) return [];
    const ids = campaigns.map((c) => c.id);
    const recipients = await pageAll((args) => this.db.whatsAppCampaignRecipient.findMany({ where: { campaignId: { in: ids } }, select: { id: true, campaignId: true, status: true, whatsAppMessage: { select: { status: true } } }, ...args }));
    return campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      at: c.startedAt ?? c.scheduledAt ?? c.createdAt,
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      recipientCount: c.recipientCount,
      recipients: recipients.filter((r) => r.campaignId === c.id).map((r) => ({ status: r.status, messageStatus: r.whatsAppMessage?.status ?? null })),
    }));
  }

  private async website(range: HrmsRange): Promise<WebsiteFigures> {
    if (this.deps.website) return this.deps.website(range);
    const r = await new LiveWebsiteDashboardService().overview(SERVICE_VIEWER, { range: "custom", from: range.from, to: range.to, scope: "WEBSITE" }, 1, 1);
    const s = r.summary;
    return {
      orders: s.totalOrders,
      revenueExcludingCancelled: s.totalValue,
      cod: s.cod,
      prepaid: s.prepaid,
      otherPayment: s.otherPayment,
      cancelled: s.cancelled,
      cancelledValue: s.cancelledValue,
      collected: s.collected,
      allShopifyOrders: r.live.shopifyOrders,
      telecallerCreatedOrders: r.live.telecallerExcluded,
    };
  }

  private async telecallerRows(range: HrmsRange): Promise<TelecallerOut[]> {
    const read =
      this.deps.telecallerWindow ??
      (async (from: string, to: string): Promise<TelecallerWindowRow[]> => {
        const data = await managerAnalyticsService.overview(SERVICE_VIEWER, { from, to, tzOffsetMinutes: IST_OFFSET_MINUTES, paymentMode: "ALL", orderStatus: "ALL", callStatus: "ALL", leadStatus: "ALL" });
        return data.salespeople.map((p) => ({
          id: p.id, name: p.name, accountStatus: p.accountStatus, leads: p.leads, contacted: p.contacted, interested: p.interested, converted: p.converted,
          calls: p.calls, connected: p.connected, notConnected: p.notConnected, failed: p.failed, uniqueLeads: p.uniqueLeads, talkTimeSec: p.talkTimeSec, productiveMs: p.productiveMs,
          orders: p.orders, codOrders: p.codOrders, prepaidOrders: p.prepaidOrders, assistedOrders: p.assistedOrders, revenue: p.revenue, assistedRevenue: p.assistedRevenue,
          collected: p.collected, codRevenue: p.codRevenue, codCollected: p.codCollected, prepaidRevenue: p.prepaidRevenue, prepaidCollected: p.prepaidCollected,
        }));
      });
    const windows = splitWindows(range.from, range.to);
    const results: TelecallerWindowRow[][] = [];
    for (const w of windows) results.push(await read(w.from, w.to)); // one window at a time: each is a heavy read
    return mergeTelecallerWindows(results);
  }

  // ------------------------------------------------------------------------------------------------ endpoints

  async health() {
    let database = false;
    try {
      await this.db.$queryRaw`SELECT 1`;
      database = true;
    } catch {
      database = false;
    }
    return { ok: database, service: "hrms-reporting", apiVersion: "v1", timezone: HRMS_TIMEZONE, database, today: todayInIst(this.now()), generatedAt: this.now().toISOString() };
  }

  async sales(range: HrmsRange): Promise<Report<Rec>> {
    const days = listDays(range.from, range.to);
    const { data, availability } = await runSections({
      crm: async () => aggregateSales(await this.orderFacts(range), days),
      website: async () => this.website(range),
    });
    return {
      data,
      availability,
      basis: {
        crm: "Orders recorded in the CRM (telecaller / CRM-created and any Shopify-synced order), by order.at = confirmedAt ?? placedAt ?? createdAt, Asia/Kolkata day. SOLD = status CONFIRMED / PROCESSING / SHIPPED / OUT_FOR_DELIVERY / DELIVERED with value left after refunds.",
        revenue: "gross = order totals of sold orders; refunded = refunds recorded on their payments; net = gross - refunded. Cancelled, returned, refunded-in-full and pending-payment orders are counted separately and are NOT revenue.",
        collection: "collected = payments with status SUCCESS (net of refunds). A COD order is collected only once its payment row is SUCCESS; outstanding = net - collected.",
        website: "Website (Shopify storefront) orders read live from Shopify for the range; telecaller-created orders are excluded from it (they are in `crm`).",
      },
      notes: ["The CRM database does not hold website orders (they are read live from Shopify), so website orders are in `website`, not in `crm`. `website` is unavailable for ranges too large to read live (see availability)."],
    };
  }

  async orders(range: HrmsRange): Promise<Report<Rec>> {
    const days = listDays(range.from, range.to);
    const { data, availability } = await runSections({
      crm: async () => aggregateOrders(await this.orderFacts(range), days),
      website: async () => this.website(range),
    });
    return {
      data,
      availability,
      basis: {
        crm: "Orders recorded in the CRM placed in the range (order.at = confirmedAt ?? placedAt ?? createdAt, Asia/Kolkata day), grouped by their CURRENT status. Drafts are excluded.",
        website: "Website (Shopify storefront) orders read live from Shopify; telecaller-created orders are excluded from it.",
      },
    };
  }

  async leads(range: HrmsRange): Promise<Report<Rec>> {
    const days = listDays(range.from, range.to);
    const { data, availability } = await runSections({
      leads: async () => aggregateLeads(await this.leadFacts(range), await this.sources(), days),
    });
    return {
      data,
      availability,
      basis: { leads: "Leads created in the range (lead.createdAt, Asia/Kolkata day), grouped by their CURRENT working status. conversionRate = converted / workable (leads that are not deactivated)." },
    };
  }

  async telecallers(range: HrmsRange): Promise<Report<Rec>> {
    const { data, availability } = await runSections({
      telecallers: async () => {
        const rows = await this.telecallerRows(range);
        return { list: rows, team: teamTotals(rows) };
      },
    });
    return {
      data,
      availability,
      basis: {
        telecallers: "The Reports' telecaller analytics (the same figures as the daily report and the Orders Dashboard): leads received in the range and how far they got, calls by start time, and sales credited by the Reports' rules (CRM confirmation, else an assisting call or action within 7 days before the sale). Revenue is net of refunds; collected is money actually received.",
      },
      notes: [
        "Only ACTIVE telecallers are listed: the Reports' analytics do not include deactivated accounts, so a telecaller who has left is missing from history.",
        "For a range longer than 92 days the figures are added up from consecutive windows; uniqueLeadsCalled is then null (it cannot be added exactly).",
      ],
    };
  }

  async employees(range: HrmsRange): Promise<Report<Rec>> {
    const now = this.now();
    const days = listDays(range.from, range.to);
    const { data, availability } = await runSections({
      employees: async () => {
        const [users, sessions, everTracked, firstSession, incentives, telecallers] = await Promise.all([
          this.db.user.findMany({ select: { id: true, name: true, role: true, status: true, createdAt: true, reportingManagerId: true }, orderBy: { name: "asc" } }),
          pageAll((args) => this.db.workSession.findMany({ where: { startedAt: { gte: range.start, lt: range.end } }, select: { id: true, userId: true, startedAt: true, endedAt: true, endReason: true, lastSeenAt: true, statusLogs: { select: { status: true, startedAt: true, endedAt: true } } }, ...args })),
          this.db.workSession.groupBy({ by: ["userId"], _count: { _all: true } }),
          this.db.workSession.aggregate({ _min: { startedAt: true } }),
          this.db.incentiveMonth.findMany({ where: { month: { gte: range.from.slice(0, 7), lte: range.to.slice(0, 7) } }, select: { userId: true, month: true, status: true, amount: true, paidAt: true }, orderBy: { month: "asc" } }),
          this.telecallerRows(range).catch(() => null),
        ]);
        const tracked = new Set(everTracked.map((r) => r.userId));
        const trackingStartedOn = firstSession._min.startedAt ? istDay(firstSession._min.startedAt) : null;
        const today = todayInIst(now);
        const perf = telecallers ? new Map(telecallers.map((t) => [t.employeeId, t])) : null;
        return users.map((u) => {
          let attendance: object | null = null;
          if (tracked.has(u.id)) {
            const mine = sessions.filter((s) => s.userId === u.id);
            const byDay = new Map<string, SessionForDay[]>();
            for (const s of mine) byDay.set(istDay(s.startedAt), [...(byDay.get(istDay(s.startedAt)) ?? []), { startedAt: s.startedAt, endedAt: s.endedAt, endReason: s.endReason, lastSeenAt: s.lastSeenAt, logs: s.statusLogs }]);
            const records = days.map((date) => dayRecord({ date, today, joinedOn: istDay(u.createdAt), trackingStartedOn, sessions: byDay.get(date) ?? [], now, tzOffsetMinutes: IST_OFFSET_MINUTES }));
            const t = totalsOf(records);
            attendance = { present: t.present, absent: t.absent, expectedDays: t.expected, attendancePercent: t.attendancePct, workedHours: Math.round((t.workingMs / 3_600_000) * 100) / 100, productiveHours: Math.round((t.productiveMs / 3_600_000) * 100) / 100 };
          }
          const months = incentives.filter((i) => i.userId === u.id);
          return {
            employeeId: u.id,
            name: u.name,
            role: u.role,
            accountStatus: u.status,
            reportingManagerId: u.reportingManagerId,
            joinedOn: istDay(u.createdAt),
            attendance,
            incentives: { months: months.map((m) => ({ month: m.month, status: m.status, amount: rupees(toPaise(m.amount)), paid: m.paidAt !== null })), totalAmount: rupees(months.reduce((a, m) => a + toPaise(m.amount), 0)), paidAmount: rupees(months.filter((m) => m.paidAt).reduce((a, m) => a + toPaise(m.amount), 0)) },
            performance: u.role === Role.SALESPERSON ? (perf ? (perf.get(u.id) ?? null) : null) : null,
          };
        });
      },
    });
    return {
      data,
      availability,
      basis: {
        employees: "Every CRM user. employeeId is the stable CRM user id - HRMS must map it to its own employee ids explicitly; the two are never assumed equal.",
        attendance: "From the CRM's work sessions, one record per Asia/Kolkata day by the day a session STARTED, with the CRM's own PRESENT / ABSENT rule (absence counted only after the 09:45 cut-off, never before joining or before tracking began). null = this user has never clocked in (not tracked).",
        incentives: "Whole-month incentive records for every month the range touches (they are not prorated to the range).",
        performance: "Telecaller figures (same as /telecallers) for ACTIVE telecallers; null for other roles and for deactivated telecallers.",
      },
    };
  }

  async products(range: HrmsRange): Promise<Report<Rec>> {
    const { data, availability } = await runSections({
      sales: async () => aggregateProducts(await this.orderFacts(range)),
      catalogue: async () => {
        const [total, active] = await Promise.all([this.db.product.count(), this.db.product.count({ where: { status: "ACTIVE" } })]);
        return { products: total, activeProducts: active, asOf: this.now().toISOString() };
      },
    });
    return {
      data,
      availability,
      basis: {
        sales: "Units and line revenue of SOLD orders (same order set and dates as /sales), per catalogue product (variants roll up to their product). grossRevenue is the sum of the order lines: it is before refunds and does not include order-level discount, shipping or tax. Free-text (custom) lines are one unnamed bucket.",
        catalogue: "A snapshot at generatedAt, not a range figure.",
      },
    };
  }

  async payments(range: HrmsRange): Promise<Report<Rec>> {
    const days = listDays(range.from, range.to);
    const { data, availability } = await runSections({
      payments: async () => aggregatePayments(await this.paymentFacts(range), range.start, range.end, days),
    });
    return {
      data,
      availability,
      basis: {
        captured: "Money actually received: payments with status SUCCESS / PARTIALLY_REFUNDED / REFUNDED dated by paidAt. A COD payment appears here only once it is SUCCESS (cash confirmed); an unconfirmed COD payment is `pending`.",
        refunds: "Refunds dated by refundedAt. net = captured - refunds, both inside the range (cash movement, not order revenue - use /sales for revenue).",
        failed: "Payments with status FAILED dated by failedAt (else createdAt).",
        pending: "Payments still PENDING / PROCESSING that were created in the range (their state now).",
        undated: "Confirmed payments with no paidAt (or refunds with no refundedAt) created in the range: real money that cannot be placed on a day, reported separately and left out of the dated totals.",
      },
    };
  }

  async marketing(range: HrmsRange): Promise<Report<Rec>> {
    const { data, availability } = await runSections({
      marketing: async () => {
        const [leads, sources, orders, campaigns] = await Promise.all([this.leadFacts(range), this.sources(), this.orderFacts(range), this.campaignFacts(range)]);
        return aggregateMarketing({ leads, sources, orders, campaigns });
      },
    });
    return {
      data,
      availability,
      basis: {
        leadSources: "New leads (lead.createdAt) per CRM lead source, with how many converted; soldOrders / netRevenue are the SOLD orders in the range (same set as /sales) whose customer's lead came from that source.",
        coupons: "SOLD orders in the range that used a coupon: orders, discount given and net revenue.",
        whatsappCampaigns: "Campaigns whose start (else scheduled, else created) date is in the range, with what the CRM did per recipient and what WhatsApp reported (delivered / read) for the messages sent.",
      },
      notes: ["Not available because the CRM holds no such data: ad spend, cost per lead, return on ad spend, impressions, clicks, email or SMS campaigns. They are not estimated."],
    };
  }
}
