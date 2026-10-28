import { dayBounds, isValidDateString, isValidTimezone, localParts, shiftDate } from "../report-automation/report-automation.report.js";

// Date range of the Orders Dashboard, in the BUSINESS timezone (not the server's or the browser's): "yesterday" is the previous calendar day there, and a day runs from 00:00 to the next 00:00 in that zone,
// so an order placed at 23:50 IST is on that IST day whatever UTC says. Orders are filtered by their CREATION time (Order.createdAt: for Shopify orders the time Shopify created it, for CRM orders the time the
// telecaller created it); abandoned checkouts by the time the checkout was detected.

export const BUSINESS_TIMEZONE = (() => {
  const configured = process.env.BUSINESS_TIMEZONE?.trim();
  return configured && isValidTimezone(configured) ? configured : "Asia/Kolkata";
})();

export const MAX_RANGE_DAYS = 366;

export const RANGE_KINDS = ["yesterday", "today", "this_week", "last_7_days", "last_30_days", "this_month", "last_month", "custom"] as const;
export type DashboardRangeKind = (typeof RANGE_KINDS)[number];
export interface DashboardRangeInput {
  range?: DashboardRangeKind;
  from?: string;
  to?: string;
}
export interface DashboardRange {
  range: DashboardRangeKind;
  /** First and last local business day, YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  /** [start, end) as instants: 00:00 of `from` to 00:00 after `to`, in the business timezone. */
  start: Date;
  end: Date;
  timezone: string;
  /** Number of calendar days in the range. */
  days: number;
}

export class DashboardRangeError extends Error {
  readonly statusCode = 400;
}

const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
/** Monday of the week containing `date` (ISO weeks start on Monday). */
const weekStart = (date: string) => shiftDate(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

/**
 * No input = YESTERDAY (never "today"). The presets are relative to today in the business timezone:
 *   today / yesterday            that one day
 *   this_week                    Monday of this week through today
 *   last_7_days / last_30_days   the 7 / 30 days ending TODAY (today included)
 *   this_month                   the 1st of this month through today
 *   last_month                   the whole previous calendar month
 * Custom needs both dates, real calendar days, from <= to, not in the future, at most a year.
 */
export function resolveDashboardRange(input: DashboardRangeInput, now: Date, timezone: string = BUSINESS_TIMEZONE): DashboardRange {
  const today = localParts(now, timezone).date;
  const kind: DashboardRangeKind = input.range ?? (input.from || input.to ? "custom" : "yesterday");
  let from: string;
  let to: string;
  switch (kind) {
    case "today":
      from = to = today;
      break;
    case "yesterday":
      from = to = shiftDate(today, -1);
      break;
    case "this_week":
      from = weekStart(today);
      to = today;
      break;
    case "last_7_days":
      from = shiftDate(today, -6);
      to = today;
      break;
    case "last_30_days":
      from = shiftDate(today, -29);
      to = today;
      break;
    case "this_month":
      from = `${today.slice(0, 7)}-01`;
      to = today;
      break;
    case "last_month": {
      const firstOfThisMonth = `${today.slice(0, 7)}-01`;
      to = shiftDate(firstOfThisMonth, -1);
      from = `${to.slice(0, 7)}-01`;
      break;
    }
    default: {
      if (!isValidDateString(input.from) || !isValidDateString(input.to)) throw new DashboardRangeError("Choose a valid From and To date (YYYY-MM-DD).");
      from = input.from;
      to = input.to;
      if (from > to) throw new DashboardRangeError("The From date must be on or before the To date.");
      if (to > today) throw new DashboardRangeError("The date range cannot extend into the future.");
      if (dayCount(from, to) > MAX_RANGE_DAYS) throw new DashboardRangeError(`Choose a range of at most ${MAX_RANGE_DAYS} days.`);
    }
  }
  return { range: kind, from, to, start: dayBounds(from, timezone).start, end: dayBounds(to, timezone).end, timezone, days: dayCount(from, to) };
}

/** The period of equal length immediately BEFORE a range - what a card's comparison text is measured against. */
export function previousRange(range: DashboardRange, timezone: string = BUSINESS_TIMEZONE): DashboardRange {
  const to = shiftDate(range.from, -1);
  const from = shiftDate(to, -(range.days - 1));
  return { range: "custom", from, to, start: dayBounds(from, timezone).start, end: dayBounds(to, timezone).end, timezone, days: range.days };
}

/** The business timezone's UTC offset in minutes for this range (the Reports take their date window as "local midnight minus offset"). */
export const tzOffsetOf = (r: Pick<DashboardRange, "from" | "start">): number => Math.round((Date.parse(`${r.from}T00:00:00.000Z`) - r.start.getTime()) / 60_000);
