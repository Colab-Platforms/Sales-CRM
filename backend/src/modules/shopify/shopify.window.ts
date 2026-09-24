// The date range a sync covers. Pure functions only; nothing here talks to Shopify or the database.
//
// Why a window: the CRM imports orders from a start date onwards (default 2026-01-01), not the store's whole history.
// Calendar days ("2026-01-01") are read in the STORE's time zone, because that is what the merchant means by "1 January";
// reading them as UTC would drop the first 5.5 hours of the day for an Indian store.

/** Used when neither --since nor SHOPIFY_SYNC_START_DATE is given. */
export const DEFAULT_START_DATE = "2026-01-01";

export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowError";
  }
}

/** What the operator typed: a calendar day (store time) or an exact moment. */
export type DateSpec = { kind: "day"; ymd: string } | { kind: "instant"; at: Date };

export interface WindowSpec {
  /** Orders created on or after this. null = the configured start date. */
  from: DateSpec | null;
  /** Orders created before the end of this day. null = now. */
  to: DateSpec | null;
  /** Incremental mode: only records changed in Shopify at or after this. */
  updatedSince: DateSpec | null;
}

export const EMPTY_WINDOW: WindowSpec = { from: null, to: null, updatedSince: null };

/** A window with real instants, ready to be sent to Shopify. `createdTo` is exclusive. */
export interface SyncWindow {
  createdFrom: Date;
  createdTo: Date;
  updatedSince: Date | null;
  timeZone: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const RELATIVE = /^(\d+)([hd])$/;

export function isRealDay(ymd: string): boolean {
  const m = DAY.exec(ymd);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
}

/** "2026-01-01", or a date-time that states its own zone ("2026-01-01T00:00:00+05:30"). Anything vaguer is refused. */
export function parseDateSpec(text: string, flag: string): DateSpec {
  const value = text.trim();
  if (DAY.test(value)) {
    if (!isRealDay(value)) throw new WindowError(`${flag} is not a real calendar date.`);
    return { kind: "day", ymd: value };
  }
  if (DATE_TIME.test(value)) {
    const at = new Date(value);
    if (!Number.isNaN(at.getTime())) return { kind: "instant", at };
  }
  throw new WindowError(`${flag} must be a date such as 2026-01-01, or a date-time with a zone such as 2026-01-01T00:00:00+05:30.`);
}

/** --updated-since also takes "24h" or "7d", meaning that long before `now`. */
export function parseUpdatedSince(text: string, now: Date): DateSpec {
  const relative = RELATIVE.exec(text.trim());
  if (relative) {
    const amount = Number(relative[1]);
    if (amount < 1) throw new WindowError("--updated-since must be at least 1h or 1d.");
    const ms = amount * (relative[2] === "h" ? 3_600_000 : 86_400_000);
    return { kind: "instant", at: new Date(now.getTime() - ms) };
  }
  return parseDateSpec(text, "--updated-since");
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** How far ahead of UTC the zone's wall clock is at that moment, in ms. */
function zoneOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a calendar day begins in the given zone. Two passes so a daylight-saving change on that day is honoured. */
export function startOfDay(ymd: string, timeZone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - zoneOffsetMs(timeZone, new Date(wall));
  return new Date(wall - zoneOffsetMs(timeZone, new Date(first)));
}

const nextDay = (ymd: string): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

const startInstant = (spec: DateSpec, timeZone: string) => (spec.kind === "day" ? startOfDay(spec.ymd, timeZone) : spec.at);

/**
 * Turns what the operator typed into real instants. The end of the window is fixed to `now` at the moment the run
 * starts, so a long backfill has a stable upper edge; orders placed after that arrive through webhooks or a later
 * --updated-since run.
 */
export function resolveWindow(spec: WindowSpec, defaultStart: string, timeZone: string, now: Date): SyncWindow {
  const createdFrom = startInstant(spec.from ?? { kind: "day", ymd: defaultStart }, timeZone);
  let createdTo = now;
  if (spec.to) {
    const end = spec.to.kind === "day" ? startOfDay(nextDay(spec.to.ymd), timeZone) : spec.to.at;
    if (end < now) createdTo = end;
  }
  if (createdFrom >= createdTo) throw new WindowError("The window is empty: the start (--since) is not before the end (--until / now).");

  const updatedSince = spec.updatedSince ? startInstant(spec.updatedSince, timeZone) : null;
  return { createdFrom, createdTo, updatedSince, timeZone };
}

/** The earliest creation time the CRM keeps by default; webhooks use it so old records are not pulled in by an edit. */
export const startFloor = (defaultStart: string, timeZone: string): Date => startOfDay(defaultStart, timeZone);

/** Shopify search syntax for the window. Terms are AND-ed. The same syntax works for orders, products and customers. */
export function windowSearch(window: SyncWindow): string {
  const terms = [`created_at:>='${window.createdFrom.toISOString()}'`, `created_at:<'${window.createdTo.toISOString()}'`];
  if (window.updatedSince) terms.push(`updated_at:>='${window.updatedSince.toISOString()}'`);
  return terms.join(" ");
}

/** "2026-01-01 00:00" in the given zone. */
export function formatInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
  return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}`;
}
