import { HrmsHttpError } from "./hrms.auth.js";

// DATE RANGES of the HRMS API. Every range is a whole number of Asia/Kolkata calendar days: [00:00 IST of `from`, 00:00 IST after `to`). India has no daylight saving, so the offset is a constant 05:30.
// There is NO maximum length (a custom range or "all_time" may span years); the cost of a long range is paid in query time, not refused here.

export const HRMS_TIMEZONE = "Asia/Kolkata";
export const IST_OFFSET_MINUTES = 330;
const MIN = 60_000;
const DAY = 86_400_000;
/** The first date a custom range may name: before the CRM existed, and a guard against typos such as year 0001. */
export const EARLIEST_DATE = "2000-01-01";

export const RANGE_PRESETS = ["today", "yesterday", "last_7_days", "last_30_days", "this_month", "last_month", "all_time", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
/** When a request names no range at all: the last COMPLETE day, never a partial "today". */
export const DEFAULT_PRESET: RangePreset = "yesterday";

export interface HrmsRange {
  kind: RangePreset;
  /** First and last calendar day, YYYY-MM-DD, inclusive, in Asia/Kolkata. */
  from: string;
  to: string;
  timezone: typeof HRMS_TIMEZONE;
  days: number;
  /** [start, end) as instants. */
  start: Date;
  end: Date;
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const shiftDay = (date: string, days: number): string => isoDay(Date.parse(`${date}T00:00:00Z`) + days * DAY);
export const todayInIst = (now: Date): string => isoDay(now.getTime() + IST_OFFSET_MINUTES * MIN);
/** The IST calendar day of an instant. */
export const istDay = (at: Date): string => isoDay(at.getTime() + IST_OFFSET_MINUTES * MIN);
/** Start of an IST calendar day as an instant. */
export const dayStart = (date: string): Date => new Date(Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MINUTES * MIN);
const dayCount = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;

export const isRealDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && isoDay(Date.parse(`${v}T00:00:00Z`)) === v;

/** Every calendar day of the range, oldest first. */
export function listDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(isoDay(t));
  return out;
}

const bad = (message: string) => new HrmsHttpError(400, "INVALID_REQUEST", message);

export interface RangeQuery {
  range?: unknown;
  from?: unknown;
  to?: unknown;
}

/**
 * Resolves a request's range. `earliest` is the first day the CRM holds data for (used only by all_time; null = nothing yet, in which case all_time is just today).
 *   today / yesterday           that one day
 *   last_7_days / last_30_days  the 7 / 30 days ENDING TODAY (today included) - the same definition the Orders Dashboard uses
 *   this_month                  the 1st of this month through today
 *   last_month                  the whole previous calendar month
 *   all_time                    the first day with data through today
 *   custom                      `from` and `to` (both required, YYYY-MM-DD, from <= to, not in the future)
 */
export function resolveHrmsRange(query: RangeQuery, now: Date, earliest: string | null = null): HrmsRange {
  const today = todayInIst(now);
  const given = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : v);
  const rawKind = given(query.range);
  const from = given(query.from);
  const to = given(query.to);
  if (Array.isArray(rawKind) || Array.isArray(from) || Array.isArray(to)) throw bad("range, from and to must each be given once.");

  let kind: RangePreset;
  if (rawKind === undefined) kind = from !== undefined || to !== undefined ? "custom" : DEFAULT_PRESET;
  else {
    const k = String(rawKind).trim().toLowerCase();
    if (!(RANGE_PRESETS as readonly string[]).includes(k)) throw bad(`Unknown range "${String(rawKind).slice(0, 40)}". Use one of: ${RANGE_PRESETS.join(", ")}.`);
    kind = k as RangePreset;
  }
  if (kind !== "custom" && (from !== undefined || to !== undefined)) throw bad('from and to are only used with range=custom (or when range is omitted).');

  let a: string;
  let b: string;
  switch (kind) {
    case "today":
      a = b = today;
      break;
    case "yesterday":
      a = b = shiftDay(today, -1);
      break;
    case "last_7_days":
      a = shiftDay(today, -6);
      b = today;
      break;
    case "last_30_days":
      a = shiftDay(today, -29);
      b = today;
      break;
    case "this_month":
      a = `${today.slice(0, 7)}-01`;
      b = today;
      break;
    case "last_month": {
      const first = `${today.slice(0, 7)}-01`;
      b = shiftDay(first, -1);
      a = `${b.slice(0, 7)}-01`;
      break;
    }
    case "all_time":
      a = earliest && earliest <= today ? earliest : today;
      b = today;
      break;
    case "custom": {
      if (from === undefined || to === undefined) throw bad("range=custom needs both from and to (YYYY-MM-DD).");
      if (!isRealDate(from) || !isRealDate(to)) throw bad("from and to must be real calendar dates in the form YYYY-MM-DD.");
      if (from > to) throw bad("from must not be after to.");
      if (from < EARLIEST_DATE) throw bad(`from must not be before ${EARLIEST_DATE}.`);
      if (to > today) throw bad(`to must not be after today (${today}).`);
      a = from;
      b = to;
      break;
    }
  }
  return { kind, from: a, to: b, timezone: HRMS_TIMEZONE, days: dayCount(a, b), start: dayStart(a), end: dayStart(shiftDay(b, 1)) };
}
