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
export type StructuredValues = Record<StructuredVariable, string>;

export const UNAVAILABLE = "N/A";

export interface WebsiteMetrics {
  totalOrders: number;
  totalRevenue: number;
  codOrders: number;
  prepaidOrders: number;
}
export interface AbandonedMetrics {
  totalLeads: number;
  ordersConverted: number;
  revenue: number;
  codOrders: number;
  prepaidOrders: number;
}
/** null = that section could not be read; each of its values is then "N/A". */
export interface TemplateMetrics {
  website: WebsiteMetrics | null;
  abandoned: AbandonedMetrics | null;
}
export type TemplateMetricsLoader = (user: { id: string; role: Role }, period: { from: string; to: string }) => Promise<TemplateMetrics>;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const count = (n: unknown): string => (finite(n) && n >= 0 ? String(Math.round(n)) : UNAVAILABLE);
/** Whole rupees with Indian digit grouping and NO currency sign - the template text already carries the rupee sign ("Total Revenue: ₹{{...}}"). */
const rupees = (n: unknown): string => (finite(n) ? Math.round(n).toLocaleString("en-IN") : UNAVAILABLE);

/** The ten values, in template shape. Pure. `reportDate` is the report's own date label in the report's timezone (Asia/Kolkata by default), e.g. "26 Oct 2026". */
export function buildStructuredValues(reportDate: string, m: TemplateMetrics): StructuredValues {
  const w = m.website;
  const a = m.abandoned;
  return {
    report_date: reportDate.replace(/[\t\r\n]+/g, " ").trim() || UNAVAILABLE,
    web_total_orders: count(w?.totalOrders),
    web_total_revenue: rupees(w?.totalRevenue),
    web_cod_orders: count(w?.codOrders),
    web_prepaid_orders: count(w?.prepaidOrders),
    aband_total_leads: count(a?.totalLeads),
    aband_orders_conv: count(a?.ordersConverted),
    aband_revenue: rupees(a?.revenue),
    aband_cod_orders: count(a?.codOrders),
    aband_prepaid_orders: count(a?.prepaidOrders),
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
export const structuredKeyOf = (name: string): StructuredVariable | undefined => (Object.hasOwn(VARIABLE_ALIASES, name) ? VARIABLE_ALIASES[name] : undefined);

/** Does the template declare exactly the ten figures, once each, under their canonical or accepted alias names (any order)? */
export function isStructuredVariableSet(names: readonly string[]): boolean {
  const keys = new Set(names.map(structuredKeyOf));
  return names.length === STRUCTURED_TEMPLATE_VARIABLES.length && keys.size === STRUCTURED_TEMPLATE_VARIABLES.length && STRUCTURED_TEMPLATE_VARIABLES.every((v) => keys.has(v));
}
