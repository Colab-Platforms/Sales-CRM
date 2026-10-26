import { shiftDate } from "../report-automation/report-automation.report.js";
import type { DashboardRange } from "./orders.dashboard.range.js";

// Pure helpers shared by the Website Orders and Abandoned Checkouts dashboards: how much of a period the CRM's data really covers, comparison with the previous period, and chart buckets.
// The rule behind all of it: a period the data does not cover is UNAVAILABLE, never shown as zero.

export type Coverage = "FULL" | "PARTIAL" | "NONE";

/**
 * How much of [range.start, range.end) the data can speak for, from the oldest and newest record the CRM holds for that dataset.
 *   NONE    nothing is held for the period (it lies wholly after the newest record, or before the oldest one): any figure there would be a made-up zero.
 *   PARTIAL the period starts before the oldest or ends after the newest record: the figure counts only what has been received.
 *   FULL    the records span the whole period. `liveUntil` (e.g. the last Shopify webhook) lets a quiet day count as a genuine zero while a live feed is running.
 */
export function coverageOf(range: { start: Date; end: Date }, oldest: Date | null, newest: Date | null, liveUntil: Date | null = null): Coverage {
  const latest = liveUntil && (!newest || liveUntil > newest) ? liveUntil : newest;
  if (!oldest || !latest) return "NONE";
  if (oldest >= range.end || latest < range.start) return "NONE";
  if (oldest > range.start || latest < range.end) return "PARTIAL";
  return "FULL";
}

/** The share of Shopify's own order count the CRM must hold for a period to be called complete (a few orders can legitimately differ: test orders, archived or just-created ones). */
export const COMPLETE_RATIO = 0.98;

/**
 * The coverage of a period, checked against Shopify when its count is known:
 *   - Shopify says 0 orders  -> FULL (a genuine zero: there was nothing to import);
 *   - the CRM holds none     -> NONE (never a zero: the orders exist, the CRM has not received them);
 *   - the CRM holds >= 98%   -> FULL;  otherwise PARTIAL (the number counts only what was imported).
 * When Shopify could not be asked (null) the first-and-last-record check `bounds` is all there is, and it can never prove a period complete (a gap in the middle is invisible to it), so FULL is capped at PARTIAL.
 */
export function verifiedCoverage(crmCount: number, shopifyCount: number | null, bounds: Coverage): Coverage {
  if (shopifyCount === null) return bounds === "FULL" ? "PARTIAL" : bounds;
  if (shopifyCount === 0) return "FULL";
  if (crmCount === 0) return "NONE";
  return crmCount / shopifyCount >= COMPLETE_RATIO ? "FULL" : "PARTIAL";
}

export const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Percentage change from `previous` to `current`; null when there is no baseline to compare with (previous is zero). */
export const pctChange = (current: number, previous: number): number | null => (previous > 0 ? round1(((current - previous) / previous) * 100) : null);

export interface Comparison {
  previous: number;
  changePct: number | null;
}
/** The comparison shown under a card - only when BOTH periods are fully covered; otherwise null (no comparison text at all). */
export function compare(current: number, previous: number, currentCoverage: Coverage, previousCoverage: Coverage): Comparison | null {
  if (currentCoverage !== "FULL" || previousCoverage !== "FULL") return null;
  return { previous, changePct: pctChange(current, previous) };
}

// ---------------------------------------------------------------------------------------------- chart buckets
export const INTERVALS = ["daily", "weekly", "monthly"] as const;
export type Interval = (typeof INTERVALS)[number];
export const TRUNC_UNIT: Record<Interval, "day" | "week" | "month"> = { daily: "day", weekly: "week", monthly: "month" };

const weekdayMon0 = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
/** First local day of the bucket a date falls in: the day itself, its Monday (ISO week), or the 1st of its month. */
export const bucketStart = (date: string, interval: Interval): string => (interval === "daily" ? date : interval === "weekly" ? shiftDate(date, -weekdayMon0(date)) : `${date.slice(0, 7)}-01`);
/** First day AFTER the bucket. */
export function bucketNext(start: string, interval: Interval): string {
  if (interval === "daily") return shiftDate(start, 1);
  if (interval === "weekly") return shiftDate(start, 7);
  const [y, m] = start.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export interface Bucket {
  /** The bucket's own first day (what the database groups by). */
  key: string;
  /** The part of the bucket inside the selected range (a week or month can stick out of it). */
  from: string;
  to: string;
}

/** Every bucket that overlaps the range, in order, clipped to it - including the ones with no records, so a gap is visible rather than silently skipped. */
export function bucketsFor(range: Pick<DashboardRange, "from" | "to">, interval: Interval): Bucket[] {
  const out: Bucket[] = [];
  for (let key = bucketStart(range.from, interval); key <= range.to; key = bucketNext(key, interval)) {
    const last = shiftDate(bucketNext(key, interval), -1);
    out.push({ key, from: key < range.from ? range.from : key, to: last > range.to ? range.to : last });
  }
  return out;
}
