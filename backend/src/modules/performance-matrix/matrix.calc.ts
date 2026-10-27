// ---------------------------------------------------------------------------------------------
// Performance Matrix rules (pure functions; the service feeds them real Call / Order / WorkSession rows).
//
//  Slots      The working day [09:30, 18:30) IST - widened by the service to every hour the team was logged in or
//             active - cut into 60-minute slots. Every call / order lands in exactly one
//             place: the slot whose half-open [start, end) holds its timestamp, or "Outside hours". So the slots plus
//             Outside hours always add up to the day's totals.
//  Status     Automatic - nothing to configure. Each person's calls and actual orders are compared with the team's
//             own pace for the same period (team average per logged-in hour, scaled to this person's logged-in
//             minutes); the two shares are averaged into a score. Green >= 80%, Amber >= 50%, Red below. A
//             logged-in period with zero calls and no order is always Red.
//  Not rated  An hour that has not ended (IN_PROGRESS / UPCOMING), an hour the salesperson was not clocked in and did
//             nothing (OFF_SHIFT), or a day with no call records for the whole team (NO_DATA, i.e. the call feed is
//             probably missing) never gets Red.
// ---------------------------------------------------------------------------------------------

export const MIN_RATED_MINUTES = 15;
/** Today's daily status waits until the salesperson has been clocked in this long. */
export const MIN_DAILY_MINUTES = 60;
export const DAY_START = 9 * 60 + 30; // 09:30 IST
export const DAY_END = DAY_START + 9 * 60; // 9-hour shift, as in the attendance module
/** Share of the team's pace needed for Green / Amber. */
export const GREEN_SHARE = 0.8;
export const AMBER_SHARE = 0.5;

export type Rag = "GREEN" | "AMBER" | "RED";
export type MatrixState = Rag | "IN_PROGRESS" | "UPCOMING" | "OFF_SHIFT" | "NO_DATA";

export interface Slot {
  key: string; // "HH:MM" of the start
  startMinutes: number;
  endMinutes: number;
}

export const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function buildSlots(startMinutes = DAY_START, endMinutes = DAY_END): Slot[] {
  const slots: Slot[] = [];
  for (let t = startMinutes; t < endMinutes; t += 60) slots.push({ key: hhmm(t), startMinutes: t, endMinutes: Math.min(t + 60, endMinutes) });
  return slots;
}

/** Report-zone day and minute-of-day of an instant. */
export function zoneClock(at: Date, tz: number): { day: string; minutes: number } {
  const l = new Date(at.getTime() + tz * 60_000);
  return { day: l.toISOString().slice(0, 10), minutes: l.getUTCHours() * 60 + l.getUTCMinutes() + l.getUTCSeconds() / 60 };
}

export const zoneInstant = (day: string, minutes: number, tz: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + (minutes - tz) * 60_000);

/** The slot holding this minute, or null for Outside hours. */
export const slotOf = (minutes: number, slots: Slot[]): Slot | null => slots.find((s) => minutes >= s.startMinutes && minutes < s.endMinutes) ?? null;

/** Clocked-in minutes inside [from, to) minutes of `day` (overlapping sessions merged). */
export function coveredMinutes(day: string, from: number, to: number, sessions: { start: Date; end: Date }[], tz: number): number {
  const s0 = zoneInstant(day, from, tz).getTime();
  const s1 = zoneInstant(day, to, tz).getTime();
  const parts = sessions
    .map((x) => [Math.max(x.start.getTime(), s0), Math.min(x.end.getTime(), s1)] as const)
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cursor = -Infinity;
  for (const [a, b] of parts) {
    const lo = Math.max(a, cursor);
    if (b > lo) covered += b - lo;
    cursor = Math.max(cursor, b);
  }
  return Math.max(0, Math.round((covered / 60_000) * 10) / 10);
}

export interface Rating {
  state: MatrixState;
  reason: string;
}

export const STATE_REASON: Record<Exclude<MatrixState, Rag>, string> = {
  IN_PROGRESS: "In progress - rated once it ends",
  UPCOMING: "Not started yet",
  OFF_SHIFT: "Not clocked in and no activity - not rated (see Attendance)",
  NO_DATA: "No call records for the whole team this day - the call feed may be missing, so this is not rated",
};

/** A period that is rated: its activity and the minutes it is judged on. */
export interface Rated {
  calls: number;
  orders: number;
  minutes: number;
}

/** Either a non-RAG state, or the minutes the period is judged on. */
export type Gate = { off: Rating } | { minutes: number };

export interface SlotInput {
  slot: Slot;
  calls: number;
  orders: number;
  covered: number;
  startsAt: Date;
  endsAt: Date;
  now: Date;
  teamHasCalls: boolean;
}

export function slotGate(i: SlotInput): Gate {
  const off = (state: Exclude<MatrixState, Rag>): Gate => ({ off: { state, reason: STATE_REASON[state] } });
  if (i.now < i.startsAt) return off("UPCOMING");
  if (i.now < i.endsAt) return off("IN_PROGRESS");
  if (!i.teamHasCalls) return off("NO_DATA");
  const active = i.calls + i.orders > 0;
  if (i.covered < MIN_RATED_MINUTES && !active) return off("OFF_SHIFT");
  // Activity without a clock-in still counts, judged against the full hour.
  return { minutes: i.covered < MIN_RATED_MINUTES ? i.slot.endMinutes - i.slot.startMinutes : i.covered };
}

export interface DayInput {
  calls: number;
  orders: number;
  /** Clocked-in minutes so far (whole day for a past day). */
  covered: number;
  /** All minutes in the working day. */
  dayMinutes: number;
  isToday: boolean;
  teamHasCalls: boolean;
}

export function dayGate(i: DayInput): Gate {
  if (!i.teamHasCalls) return { off: { state: "NO_DATA", reason: STATE_REASON.NO_DATA } };
  const active = i.calls + i.orders > 0;
  if (i.covered < MIN_RATED_MINUTES && !active) return { off: { state: "OFF_SHIFT", reason: "Not clocked in and no activity this day - see Attendance" } };
  if (i.isToday && i.covered < MIN_DAILY_MINUTES && !active) return { off: { state: "IN_PROGRESS", reason: "Clocked in under an hour so far - rated later today" } };
  return { minutes: i.covered < MIN_RATED_MINUTES ? i.dayMinutes : i.covered };
}

/** The team's pace: calls and orders per logged-in hour across every rated person in the period (0 when none). */
export interface Pace {
  calls: number;
  orders: number;
}

export function teamPace(rated: Rated[]): Pace {
  const hours = rated.reduce((a, r) => a + r.minutes, 0) / 60;
  if (hours <= 0) return { calls: 0, orders: 0 };
  return { calls: rated.reduce((a, r) => a + r.calls, 0) / hours, orders: rated.reduce((a, r) => a + r.orders, 0) / hours };
}

/** One measure can lift the score by at most this much, so a single lucky order cannot hide very few calls. */
export const RATIO_CAP = 1.2;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const one = (n: number) => Math.round(n * 10) / 10;

/**
 * Performance score = this person's calls and actual orders, each as a share of what the team averaged for the same
 * logged-in time, weighted equally. When the team averages under one order for that time, orders only add (a missing
 * order is not held against anyone). Green >= 80%, Amber >= 50%, Red below.
 * Nothing at all while logged in is always Red.
 */
export function rate(r: Rated, pace: Pace): Rating {
  const hours = r.minutes / 60;
  const expCalls = pace.calls * hours;
  const expOrders = pace.orders * hours;
  const ratio = (got: number, exp: number) => (exp > 0 ? Math.min(RATIO_CAP, got / exp) : got > 0 ? RATIO_CAP : 1);
  const callShare = ratio(r.calls, expCalls);
  const both = (callShare + ratio(r.orders, expOrders)) / 2;
  // Orders count fully once the team averages at least one in this time; rarer than that, missing one is not a
  // shortfall, so orders can only lift the score.
  const score = expOrders >= 1 ? both : Math.max(callShare, expOrders > 0 ? both : 0);
  const state: Rag = r.calls + r.orders === 0 ? "RED" : score >= GREEN_SHARE ? "GREEN" : score >= AMBER_SHARE ? "AMBER" : "RED";
  const parts = [`${plural(r.calls, "call")} (team avg ${one(expCalls)})`];
  if (expOrders > 0 || r.orders > 0) parts.push(`${plural(r.orders, "order")} (team avg ${one(expOrders)})`);
  return { state, reason: `${parts.join(", ")} for the same logged-in time - score ${Math.round(score * 100)}%` };
}
