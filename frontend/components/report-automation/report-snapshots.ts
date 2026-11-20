import type { ReportSnapshot } from "@/lib/api-client/types/report-automation.types";

// Pure helpers for the snapshot history: the metric rows of a frozen report and the comparison of two of them. Everything shown is read from the stored snapshot - never recomputed.

export type SnapshotSection = "Shopify orders" | "Website orders" | "Abandoned checkouts";
export const SECTION_SHORT: Record<SnapshotSection, string> = { "Shopify orders": "Shopify", "Website orders": "Website", "Abandoned checkouts": "Abandoned" };

export interface SnapshotMetric {
  key: string;
  section: SnapshotSection;
  label: string;
  money: boolean;
  /** Rupees with paise (two decimals) instead of whole rupees. */
  exact?: boolean;
  read: (s: ReportSnapshot) => number | null;
}

// A section a snapshot does not have (taken before it existed, or not read) gives null: shown as "-", never a made-up zero.
const sh = (pick: (f: NonNullable<ReportSnapshot["figures"]["shopify"]>) => number | undefined) => (s: ReportSnapshot) => (s.figures.shopify ? (pick(s.figures.shopify) ?? null) : null);
const w = (pick: (f: NonNullable<ReportSnapshot["figures"]["website"]>) => number | undefined) => (s: ReportSnapshot) => (s.figures.website ? (pick(s.figures.website) ?? null) : null);
const a = (pick: (f: NonNullable<ReportSnapshot["figures"]["abandoned"]>) => number | undefined) => (s: ReportSnapshot) => (s.figures.abandoned ? (pick(s.figures.abandoned) ?? null) : null);

export const SNAPSHOT_METRICS: SnapshotMetric[] = [
  { key: "sh_total", section: "Shopify orders", label: "Total Shopify orders", money: false, read: sh((f) => f.totalOrders) },
  { key: "sh_website", section: "Shopify orders", label: "Website orders", money: false, read: sh((f) => f.websiteOrders) },
  { key: "sh_telecaller", section: "Shopify orders", label: "Telecaller-created orders", money: false, read: sh((f) => f.telecallerOrders) },
  { key: "sh_revenue", section: "Shopify orders", label: "Total revenue", money: true, exact: true, read: sh((f) => f.totalRevenue) },
  { key: "web_total", section: "Website orders", label: "Total orders", money: false, read: w((f) => f.totalOrders) },
  { key: "web_revenue", section: "Website orders", label: "Revenue", money: true, read: w((f) => f.totalRevenue) },
  { key: "web_cod", section: "Website orders", label: "COD orders", money: false, read: w((f) => f.codOrders) },
  { key: "web_prepaid", section: "Website orders", label: "Prepaid orders", money: false, read: w((f) => f.prepaidOrders) },
  { key: "web_other", section: "Website orders", label: "Other payment orders", money: false, read: w((f) => f.otherOrders) },
  { key: "ab_leads", section: "Abandoned checkouts", label: "Total leads", money: false, read: a((f) => f.totalLeads) },
  { key: "ab_converted", section: "Abandoned checkouts", label: "Orders converted", money: false, read: a((f) => f.ordersConverted) },
  { key: "ab_revenue", section: "Abandoned checkouts", label: "Revenue", money: true, read: a((f) => f.revenue) },
  { key: "ab_cod", section: "Abandoned checkouts", label: "COD orders", money: false, read: a((f) => f.codOrders) },
  { key: "ab_prepaid", section: "Abandoned checkouts", label: "Prepaid orders", money: false, read: a((f) => f.prepaidOrders) },
];
export const metricByKey = (key: string): SnapshotMetric => SNAPSHOT_METRICS.find((m) => m.key === key)!;

export const formatMetric = (v: number | null, money: boolean, exact = false): string =>
  v === null ? "-" : money ? `₹${exact ? v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(v).toLocaleString("en-IN")}` : String(v);

export interface ComparedRow { key: string; section: SnapshotSection; label: string; money: boolean; exact: boolean; left: number | null; right: number | null; delta: number | null }

/** `left` vs `right`, metric by metric. delta = right - left, null when either side has no figure. */
export function compareSnapshots(left: ReportSnapshot, right: ReportSnapshot): ComparedRow[] {
  return SNAPSHOT_METRICS.map((m) => {
    const l = m.read(left);
    const r = m.read(right);
    return { key: m.key, section: m.section, label: m.label, money: m.money, exact: Boolean(m.exact), left: l, right: r, delta: l === null || r === null ? null : Math.round((r - l) * 100) / 100 };
  });
}

export const formatDelta = (d: number | null, money: boolean, exact = false): string => (d === null ? "-" : d === 0 ? "same" : `${d > 0 ? "+" : "-"}${formatMetric(Math.abs(d), money, exact)}`);
