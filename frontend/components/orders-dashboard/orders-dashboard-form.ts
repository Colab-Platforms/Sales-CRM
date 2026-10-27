import { Banknote, CheckCircle2, Clock, CreditCard, IndianRupee, PackageCheck, ShoppingCart, XCircle } from "lucide-react";
import type { ComponentType } from "react";
import type { DashboardFulfilmentFilter, DashboardMetric, DashboardRangeKind, DashboardPaymentFilter, DashboardSection, OrdersDashboardQuery, OrdersDashboardSummary } from "@/lib/api-client/types/orders-dashboard.types";

// Business timezone of the dashboard. The SERVER decides what "yesterday" is (in its configured business timezone); this is only used to stop the date pickers offering future days.
export const BUSINESS_TIMEZONE = "Asia/Kolkata";
export const MAX_RANGE_DAYS = 366;

/** Yesterday is the default - never today - and NO card is selected: the page opens with the cards only, no order rows. */
export const DEFAULT_QUERY: OrdersDashboardQuery = { range: "yesterday", page: 1, pageSize: 25 };

export const todayIn = (timezone: string = BUSINESS_TIMEZONE, now: Date = new Date()): string => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

const isRealDate = (v: string | undefined): v is string => Boolean(v) && /^\d{4}-\d{2}-\d{2}$/.test(v!) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Client-side mirror of the server's check, so a bad range is explained before a request is made (the server stays the authority). */
export function validateCustomRange(from: string | undefined, to: string | undefined, today: string = todayIn()): string | null {
  if (!isRealDate(from) || !isRealDate(to)) return "Choose both a From and a To date.";
  if (from > to) return "The From date must be on or before the To date.";
  if (to > today) return "The date range cannot extend into the future.";
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) return `Choose a range of at most ${MAX_RANGE_DAYS} days.`;
  return null;
}

/** The date presets, in the order they are offered. Yesterday is the default. */
export const RANGE_OPTIONS: DashboardRangeKind[] = ["today", "yesterday", "this_week", "last_7_days", "last_30_days", "this_month", "last_month", "custom"];
export const RANGE_LABEL: Record<DashboardRangeKind, string> = { today: "Today", yesterday: "Yesterday", this_week: "This Week", last_7_days: "Last 7 Days", last_30_days: "Last 30 Days", this_month: "This Month", last_month: "Last Month", custom: "Custom Range" };
export const SECTION_LABEL: Record<DashboardSection, string> = { WEBSITE: "Website Orders", TELECALLER: "Telecaller Orders" };
export const PAYMENT_LABEL: Record<DashboardPaymentFilter, string> = {
  SUCCESS: "Paid",
  PENDING: "Pending",
  PROCESSING: "Processing",
  FAILED: "Failed",
  REFUNDED: "Refunded",
  PARTIALLY_REFUNDED: "Partially refunded",
  NO_PAYMENT: "No payment recorded",
};
export const FULFILMENT_LABEL: Record<DashboardFulfilmentFilter, string> = { UNFULFILLED: "Unfulfilled", FULFILLED: "Fulfilled (shipped / delivered)", CANCELLED: "Cancelled", RETURNED: "Returned / refunded" };

export const formatInr = (n: number): string => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** The eight summary cards, in display order. `key` is what the server filters by when the card is clicked. */
export type CardId = DashboardMetric | "COD_REVENUE" | "PREPAID_REVENUE" | "COLLECTED";
/** `key` = which orders the server lists when the card is clicked; `id` = the card itself (a revenue card lists the same orders as its count card, and the table shows each order's amount). */
export const CARDS: { key: DashboardMetric; id: CardId; label: string; hint?: string }[] = [
  { key: "TOTAL", id: "TOTAL", label: "Total Orders" },
  { key: "VALUE", id: "VALUE", label: "Revenue", hint: "Total order value, excluding cancelled orders" },
  { key: "COD", id: "COD", label: "COD Orders" },
  { key: "COD", id: "COD_REVENUE", label: "Revenue - COD", hint: "Value of the COD orders (not cancelled)" },
  { key: "PREPAID", id: "PREPAID", label: "Prepaid Orders" },
  { key: "PREPAID", id: "PREPAID_REVENUE", label: "Revenue - Prepaid", hint: "Value of the prepaid orders (not cancelled)" },
  { key: "PAID", id: "PAID", label: "Paid" },
  { key: "PAID", id: "COLLECTED", label: "Collected", hint: "Money received (successful payments, net of partial refunds)" },
  { key: "PENDING", id: "PENDING", label: "Pending Payment" },
  { key: "CANCELLED", id: "CANCELLED", label: "Cancelled" },
  { key: "FULFILLED", id: "FULFILLED", label: "Fulfilled", hint: "Shipped or delivered" },
];

export const cardLabel = (m: DashboardMetric): string => CARDS.find((c) => c.key === m)!.label;

/** What a card shows. The value card is money; the others are order counts. */
export function cardValueFor(summary: OrdersDashboardSummary, id: CardId): string {
  switch (id) {
    case "COD_REVENUE": return formatInr(summary.codRevenue);
    case "PREPAID_REVENUE": return formatInr(summary.prepaidRevenue);
    case "COLLECTED": return formatInr(summary.collected);
    default: return cardValue(summary, id);
  }
}

export function cardValue(summary: OrdersDashboardSummary, m: DashboardMetric): string {
  switch (m) {
    case "TOTAL": return String(summary.totalOrders);
    case "VALUE": return formatInr(summary.totalValue);
    case "COD": return String(summary.cod);
    case "PREPAID": return String(summary.prepaid);
    case "PAID": return String(summary.paid);
    case "PENDING": return String(summary.pendingPayment);
    case "CANCELLED": return String(summary.cancelled);
    case "FULFILLED": return String(summary.fulfilled);
  }
}

/** "25 Oct 2026" or "20 Oct 2026 - 25 Oct 2026". */
export function describeRange(r: { from: string; to: string }): string {
  const f = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  return r.from === r.to ? f(r.from) : `${f(r.from)} - ${f(r.to)}`;
}

/** Clicking a card opens (or re-targets) the one details section: the date range, tab and search/filters stay as they are, the page goes back to 1. A card is never selected on load. */
export const selectCard = (q: OrdersDashboardQuery, metric: DashboardMetric): OrdersDashboardQuery => ({ ...q, metric, section: q.section ?? "WEBSITE", page: 1 });

/** Back to the cards-only view: the date range is kept; the card, tab, search, filters and page are dropped. */
export const closeDetails = (q: OrdersDashboardQuery): OrdersDashboardQuery => ({ range: q.range, from: q.from, to: q.to, scope: q.scope, page: 1, pageSize: q.pageSize });

/** Switching tab keeps the card, the date range and the filters; only the page restarts. */
export const switchTab = (q: OrdersDashboardQuery, section: DashboardSection): OrdersDashboardQuery => ({ ...q, section, page: 1 });

/** Changing the date range keeps the open card and tab (and filters); the page restarts. */
export const changeRange = (q: OrdersDashboardQuery, patch: Pick<OrdersDashboardQuery, "range" | "from" | "to">): OrdersDashboardQuery => ({ ...q, ...patch, page: 1 });

/** Search / payment / fulfilment filters inside the open details; the page restarts. */
export const withFilters = (q: OrdersDashboardQuery, patch: Partial<Pick<OrdersDashboardQuery, "search" | "paymentStatus" | "fulfilment">>): OrdersDashboardQuery => ({ ...q, ...patch, page: 1 });

// ---------------------------------------------------------------------------------------------- shared date range + the two dashboards
export interface RangeState {
  range: DashboardRangeKind;
  from?: string;
  to?: string;
}
/** The date range both dashboards share. Yesterday by default; kept when switching between the dashboards. */
export const DEFAULT_RANGE: RangeState = { range: "yesterday" };

export type DashboardKind = "WEBSITE" | "ABANDONED";
export const DASHBOARD_LABEL: Record<DashboardKind, string> = { WEBSITE: "Website Orders", ABANDONED: "Abandoned Checkouts" };

/** A new-order-feed health message for the Website dashboard, from what the CRM database knows. Returns null when the feed looks healthy for the selected range. */
export function websiteFeedWarning(
  f: { latestWebsiteOrderAt: string | null; websiteMayBeIncomplete: boolean; shopifyWebhooksReceived: number; lastShopifyWebhookAt: string | null },
  fmt: (iso: string) => string,
  check: { coverage: "FULL" | "PARTIAL" | "NONE"; verification: { shopifyCount: number | null; crmCount: number; verified: boolean } | null } | null = null,
): string | null {
  // Shopify's own count for the period is the proof: the CRM holds fewer orders than Shopify has, so the figures are incomplete whatever the newest order's date says.
  const v = check?.verification;
  if (v && v.verified && v.shopifyCount !== null && check.coverage !== "FULL") {
    return `Shopify has ${v.shopifyCount.toLocaleString("en-IN")} orders for this period but the CRM holds ${v.crmCount.toLocaleString("en-IN")}. The numbers below count only the orders imported so far and are incomplete until the missing Shopify orders are synced.`;
  }
  if (!f.websiteMayBeIncomplete && !(check && check.coverage !== "FULL")) return null;
  const newest = f.latestWebsiteOrderAt ? `The newest website order in the CRM is from ${fmt(f.latestWebsiteOrderAt)}.` : "The CRM holds no website orders yet.";
  const feed =
    f.shopifyWebhooksReceived === 0
      ? "This CRM has never received a Shopify order webhook, so website orders only appear after a Shopify sync is run by hand."
      : `The last Shopify webhook arrived ${f.lastShopifyWebhookAt ? fmt(f.lastShopifyWebhookAt) : "(unknown)"}.`;
  return `${newest} ${feed} Website orders placed after that are NOT shown - the counts here are incomplete until the Shopify feed is connected and caught up.`;
}

export const CARD_ICONS: Record<DashboardMetric, ComponentType<{ className?: string }>> = { TOTAL: ShoppingCart, VALUE: IndianRupee, COD: Banknote, PREPAID: CreditCard, PAID: CheckCircle2, PENDING: Clock, CANCELLED: XCircle, FULFILLED: PackageCheck };

/** "vs previous day" / "vs previous 7 days" - the period a comparison is measured against. */
export const compareLabel = (days: number): string => (days === 1 ? "vs previous day" : `vs previous ${days} days`);
