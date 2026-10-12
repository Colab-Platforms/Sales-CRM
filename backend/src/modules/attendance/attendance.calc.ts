import { WorkStatus } from "../../../generated/prisma/enums.js";
import {
  BREAK_LIMIT_MS,
  BREAK_STATUSES,
  PRODUCTIVE_TARGET_MS,
  SHIFT_MS,
} from "./attendance.constants.js";
import type { AttendanceSummary, LogInterval } from "./attendance.types.js";

function overlapMs(log: LogInterval, from: Date, to: Date): number {
  const start = Math.max(log.startedAt.getTime(), from.getTime());
  const end = Math.min((log.endedAt ?? to).getTime(), to.getTime());
  return Math.max(0, end - start);
}

// Everything the timers and reports show, derived from one shift's status log. Breaks are tea+lunch+bio;
// team huddle is tracked on its own and is NOT a break. Productive = shift - breaks - huddle: calling
// counts as productive (it's reported separately) and idle is reported but not deducted.
export function computeSummary(logs: LogInterval[], shiftStart: Date, shiftEnd: Date): AttendanceSummary {
  const sum = (match: (s: WorkStatus) => boolean) =>
    logs.filter((l) => match(l.status)).reduce((total, l) => total + overlapMs(l, shiftStart, shiftEnd), 0);

  const teaMs = sum((s) => s === WorkStatus.TEA_BREAK);
  const lunchMs = sum((s) => s === WorkStatus.LUNCH_BREAK);
  const bioMs = sum((s) => s === WorkStatus.BIO_BREAK);
  const breakTotalMs = sum((s) => BREAK_STATUSES.has(s));
  const huddleMs = sum((s) => s === WorkStatus.TEAM_HUDDLE);
  const callingMs = sum((s) => s === WorkStatus.ON_CALL);
  const idleMs = sum((s) => s === WorkStatus.IDLE);

  const shiftElapsedMs = Math.max(0, shiftEnd.getTime() - shiftStart.getTime());
  const productiveMs = Math.max(0, shiftElapsedMs - breakTotalMs - huddleMs);

  return {
    shiftElapsedMs,
    shiftRemainingMs: Math.max(0, SHIFT_MS - shiftElapsedMs),
    shiftOverrunMs: Math.max(0, shiftElapsedMs - SHIFT_MS),
    teaMs,
    lunchMs,
    bioMs,
    breakTotalMs,
    breakRemainingMs: Math.max(0, BREAK_LIMIT_MS - breakTotalMs),
    breakOverageMs: Math.max(0, breakTotalMs - BREAK_LIMIT_MS),
    huddleMs,
    callingMs,
    idleMs,
    productiveMs,
    productiveTargetMs: PRODUCTIVE_TARGET_MS,
    targetMet: productiveMs >= PRODUCTIVE_TARGET_MS,
  };
}

// Several shifts in one day (e.g. logged out for lunch and back in): add the raw durations and
// re-derive the limits from the totals.
export function mergeSummaries(summaries: AttendanceSummary[]): AttendanceSummary {
  const total = (pick: (s: AttendanceSummary) => number) => summaries.reduce((acc, s) => acc + pick(s), 0);
  const shiftElapsedMs = total((s) => s.shiftElapsedMs);
  const breakTotalMs = total((s) => s.breakTotalMs);
  const huddleMs = total((s) => s.huddleMs);
  const productiveMs = Math.max(0, shiftElapsedMs - breakTotalMs - huddleMs);

  return {
    shiftElapsedMs,
    shiftRemainingMs: Math.max(0, SHIFT_MS - shiftElapsedMs),
    shiftOverrunMs: Math.max(0, shiftElapsedMs - SHIFT_MS),
    teaMs: total((s) => s.teaMs),
    lunchMs: total((s) => s.lunchMs),
    bioMs: total((s) => s.bioMs),
    breakTotalMs,
    breakRemainingMs: Math.max(0, BREAK_LIMIT_MS - breakTotalMs),
    breakOverageMs: Math.max(0, breakTotalMs - BREAK_LIMIT_MS),
    huddleMs,
    callingMs: total((s) => s.callingMs),
    idleMs: total((s) => s.idleMs),
    productiveMs,
    productiveTargetMs: PRODUCTIVE_TARGET_MS,
    targetMet: productiveMs >= PRODUCTIVE_TARGET_MS,
  };
}

// Midnight-to-midnight bounds of a "YYYY-MM-DD" day in the reporting zone, as UTC instants.
export function dayBounds(date: string, tzOffsetMinutes: number): { from: Date; to: Date } {
  const startUtc = Date.parse(`${date}T00:00:00.000Z`) - tzOffsetMinutes * 60_000;
  return { from: new Date(startUtc), to: new Date(startUtc + 24 * 60 * 60_000) };
}

export function todayString(now: Date, tzOffsetMinutes: number): string {
  return new Date(now.getTime() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}
