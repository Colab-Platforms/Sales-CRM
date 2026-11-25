import type { Role } from "../../../generated/prisma/enums.js";

// The numbers of the INITIAL notification template ("AyushWellness CRM - {{report_date}}": website orders and abandoned checkouts). They come from the SAME services as the Orders Dashboard cards
// (LiveWebsiteDashboardService for Website Orders, AbandonedDashboardService for Abandoned Checkouts), for the report's own date range, so the message and the dashboard cannot disagree. Nothing is
// recomputed here. A figure that cannot be read is sent as "N/A" - never as a made-up zero.

/** The ten named body variables of the approved template, in the order they appear in it. A template is only used in this shape when ALL of them (and no others) are declared. */
export const STRUCTURED_TEMPLATE_VARIABLES = [
  "report_date",
  "web_total_orders",
  "web_total_revenue",
  "web_cod_orders",
  "web_prepaid_orders",
  "aband_total_leads",
  "aband_orders_conv",
  "aband_revenue",
  "aband_cod_orders",
  "aband_prepaid_orders",
] as const;
export type StructuredVariable = (typeof STRUCTURED_TEMPLATE_VARIABLES)[number];
/** OPTIONAL eleventh variable: website orders with no payment method (neither COD nor prepaid). A template may declare the ten alone (as already approved) or the ten plus this one. */
export const OPTIONAL_TEMPLATE_VARIABLE = "web_other_orders" as const;
export type AnyStructuredVariable = StructuredVariable | typeof OPTIONAL_TEMPLATE_VARIABLE;

/**
 * The FIVE named variables of the "Shopify Orders Summary" template (aayushwellness_daily_team_report_3), in the order they appear in its body - {{1}} to {{5}} of the message:
 *   report_date (1), total_shopify_orders (2), website_orders (3), telecaller_orders (4), total_revenue (5).
 * Named, not positional: this CRM only submits and sends named-format templates (the Meta API rejects positional parameters for them). All within Meta's 20-character limit.
 */
export const SHOPIFY_SUMMARY_VARIABLES = ["report_date", "total_shopify_orders", "website_orders", "telecaller_orders", "total_revenue"] as const;
export type ShopifySummaryVariable = (typeof SHOPIFY_SUMMARY_VARIABLES)[number];
export type StructuredValues = Record<AnyStructuredVariable | ShopifySummaryVariable, string>;
/** Which sections of the figures a template needs, so a snapshot is only frozen once every section it actually sends was read. No argument = the original website + abandoned shape. */
export interface StructuredNeed {
  shopify?: boolean;
  legacy?: boolean;
}

export const UNAVAILABLE = "N/A";

export interface WebsiteMetrics {
  totalOrders: number;
  totalRevenue: number;
  codOrders: number;
  prepaidOrders: number;
  /** Orders with no payment method (cod + prepaid + other = total). */
  otherOrders?: number;
}
export interface AbandonedMetrics {
  totalLeads: number;
  ordersConverted: number;
  revenue: number;
  codOrders: number;
  prepaidOrders: number;
}
/** The complete Shopify order set of the report's day(s): website orders + telecaller-created orders (the "Order Created by" ones are NOT excluded). Cancelled orders are still COUNTED; the revenue leaves them (and returned / refunded ones) out. */
export interface ShopifyMetrics {
  /** Every Shopify order (always websiteOrders + telecallerOrders). */
  totalOrders: number;
  websiteOrders: number;
  telecallerOrders: number;
  /** Of telecallerOrders, those not cancelled, returned or refunded. Optional: figures frozen before this existed omit it. */
  telecallerSuccessfulOrders?: number;
  /** Revenue in rupees (two decimals) EXCLUDING cancelled, returned and refunded orders (net of partial refunds). The order counts above still include those orders. */
  totalRevenue: number;
}
/** null = that section could not be read; each of its values is then "N/A". */
export interface TemplateMetrics {
  website: WebsiteMetrics | null;
  abandoned: AbandonedMetrics | null;
  /** The Shopify Orders Summary figures. Optional so figures built before this section existed stay valid. */
  shopify?: ShopifyMetrics | null;
}
export type TemplateMetricsLoader = (user: { id: string; role: Role }, period: { from: string; to: string }) => Promise<TemplateMetrics>;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const count = (n: unknown): string => (finite(n) && n >= 0 ? String(Math.round(n)) : UNAVAILABLE);
/** Whole rupees with Indian digit grouping and NO currency sign - the template text already carries the rupee sign ("Total Revenue: ₹{{...}}"). */
const rupees = (n: unknown): string => (finite(n) ? Math.round(n).toLocaleString("en-IN") : UNAVAILABLE);
/** Rupees with paise (always two decimals) and Indian grouping, no currency sign: 127581.05 -> "1,27,581.05". */
const rupeesExact = (n: unknown): string => (finite(n) ? n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : UNAVAILABLE);

/** The telecaller slot shows ONLY the successful telecaller-created orders (not cancelled, returned or refunded), as a plain number - no total beside it. Figures frozen before the successful count existed fall back to their stored total, so an old snapshot never turns into N/A. */
const telecallerText = (sh: ShopifyMetrics | null | undefined): string => (finite(sh?.telecallerSuccessfulOrders) ? count(sh?.telecallerSuccessfulOrders) : count(sh?.telecallerOrders));

/** The ten values, in template shape. Pure. `reportDate` is the report's own date label in the report's timezone (Asia/Kolkata by default), e.g. "26 Oct 2026". */
export function buildStructuredValues(reportDate: string, m: TemplateMetrics): StructuredValues {
  const w = m.website;
  const a = m.abandoned;
  const sh = m.shopify;
  return {
    report_date: reportDate.replace(/[\t\r\n]+/g, " ").trim() || UNAVAILABLE,
    web_total_orders: count(w?.totalOrders),
    web_total_revenue: rupees(w?.totalRevenue),
    web_cod_orders: count(w?.codOrders),
    web_prepaid_orders: count(w?.prepaidOrders),
    web_other_orders: count(w?.otherOrders),
    aband_total_leads: count(a?.totalLeads),
    aband_orders_conv: count(a?.ordersConverted),
    aband_revenue: rupees(a?.revenue),
    aband_cod_orders: count(a?.codOrders),
    aband_prepaid_orders: count(a?.prepaidOrders),
    total_shopify_orders: count(sh?.totalOrders),
    website_orders: count(sh?.websiteOrders),
    telecaller_orders: telecallerText(sh),
    total_revenue: rupeesExact(sh?.totalRevenue),
  };
}

/** Meta rejects a named body parameter longer than this (HTTP 400, code 100: "parameter_name must be at most 20 characters long"). */
export const MAX_PARAMETER_NAME_LENGTH = 20;

/** The names that exceed Meta's limit, with their length. Checked BEFORE a send, so the failure is a clear message and not a provider error. */
export const overlongParameterNames = (names: readonly string[]): { name: string; length: number }[] =>
  names.filter((n) => n.length > MAX_PARAMETER_NAME_LENGTH).map((n) => ({ name: n, length: n.length }));

/**
 * The variable names an approved template may use for each of the ten figures. The canonical names are the ones above (all within Meta's 20 characters). Older names are still RECOGNISED so a template
 * created with them is explained precisely (and refused if too long) instead of being treated as an unrelated template: the earlier long names, and the four shorter ones the first
 * "aayushwellness_daily_team_report" was approved with. Recognised is not renamed: the sender always sends the names stored from Meta.
 */
const VARIABLE_ALIASES: Readonly<Record<string, StructuredVariable>> = {
  ...Object.fromEntries(STRUCTURED_TEMPLATE_VARIABLES.map((v) => [v, v])),
  website_total_orders: "web_total_orders",
  website_total_revenue: "web_total_revenue",
  website_cod_orders: "web_cod_orders",
  website_prepaid_orders: "web_prepaid_orders",
  abandoned_total_leads: "aband_total_leads",
  abandoned_orders_converted: "aband_orders_conv",
  abandoned_revenue: "aband_revenue",
  abandoned_cod_orders: "aband_cod_orders",
  abandoned_prepaid_orders: "aband_prepaid_orders",
  total_orders: "web_total_orders",
  website_revenue: "web_total_revenue",
  total_leads: "aband_total_leads",
  orders_converted: "aband_orders_conv",
};

/** Which figure a template's variable stands for (undefined = not one of the ten). */
export const structuredKeyOf = (name: string): AnyStructuredVariable | undefined => (name === OPTIONAL_TEMPLATE_VARIABLE ? OPTIONAL_TEMPLATE_VARIABLE : Object.hasOwn(VARIABLE_ALIASES, name) ? VARIABLE_ALIASES[name] : undefined);

/** Does the template declare exactly the ten figures, once each, under their canonical or accepted alias names (any order)? */
export function isStructuredVariableSet(names: readonly string[]): boolean {
  const keys = new Set(names.map(structuredKeyOf));
  // the ten figures, optionally plus web_other_orders (an eleventh); nothing else is accepted
  const expected = STRUCTURED_TEMPLATE_VARIABLES.length + (keys.has(OPTIONAL_TEMPLATE_VARIABLE) ? 1 : 0);
  return names.length === expected && keys.size === expected && STRUCTURED_TEMPLATE_VARIABLES.every((v) => keys.has(v));
}

/** Does the template declare exactly the five Shopify Orders Summary variables, once each (any order) and nothing else? */
export function isShopifySummarySet(names: readonly string[]): boolean {
  const set = new Set(names);
  return names.length === SHOPIFY_SUMMARY_VARIABLES.length && set.size === SHOPIFY_SUMMARY_VARIABLES.length && SHOPIFY_SUMMARY_VARIABLES.every((v) => set.has(v));
}
