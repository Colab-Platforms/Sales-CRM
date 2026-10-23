import { SessionEndReason } from "../../../generated/prisma/enums.js";
import { ATTENDANCE_CUTOFF_MINUTES, BREAK_LIMIT_MS } from "./attendance.constants.js";
import { computeSummary, mergeSummaries } from "./attendance.calc.js";
import type { LogInterval } from "./attendance.types.js";

// ---------------------------------------------------------------------------------------------
// Attendance records: one status per employee per calendar day (report timezone), derived only from
// the WorkSession rows that person actually has. Nothing is written; nothing is inferred from leads/calls.
//
//  PRESENT     clocked in that day (any time - there is no Late status)
//  ABSENT      no clock-in on a day the employee should have worked (on/after joining); today counts
//              once ATTENDANCE_CUTOFF_MINUTES has passed without a clock-in (a later clock-in turns it into PRESENT)
//  PENDING     today before the cut-off, not clocked in yet ("Not Yet Recorded") - not counted either way
//  NOT_JOINED  a day before the employee's account existed - not expected, not counted
//  NOT_TRACKED a day before the CRM recorded any attendance at all - nobody could clock in, not counted
//
// A session belongs to the day it STARTED on (an overnight shift stays on its start day). Several
// sessions in one day are merged into one record, so a re-login never creates a second attendance.
// Policy: every day is a working day; the CRM holds no weekly-off, half-day, leave or holiday records. Only
// PRESENT and ABSENT are attendance statuses; PENDING / NOT_JOINED / NOT_TRACKED are "no status" and never counted.
// ---------------------------------------------------------------------------------------------

export type DayStatus = "PRESENT" | "ABSENT" | "PENDING" | "NOT_JOINED" | "NOT_TRACKED";
export type StatusFilter = "ALL" | "PRESENT" | "ABSENT";

const DAY_MS = 24 * 60 * 60_000;

export interface SessionForDay {
  startedAt: Date;
  endedAt: Date | null;
  endReason: SessionEndReason | null;
  lastSeenAt: Date;
  logs: LogInterval[];
}

export interface DayRecord {
  date: string;
  status: DayStatus;
  checkIn: string | null;
  /** Null while a session is still open, or when there is no session. */
  checkOut: string | null;
  stillWorking: boolean;
  workingMs: number;
  productiveMs: number;
  breakMs: number;
  sessions: number;
  /** Calls the employee made that day (any outcome), and the talk time of the connected ones. */
  calls: number;
  talkTimeSec: number;
  remarks: string[];
}

export interface DayCalls {
  calls: number;
  talkTimeSec: number;
}

/** "YYYY-MM-DD" of an instant in the report zone. */
export function zoneDay(at: Date, tzOffsetMinutes: number): string {
  return new Date(at.getTime() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Every calendar day from `from` to `to`, both included. */
export function listDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00.000Z`); t <= Date.parse(`${to}T00:00:00.000Z`); t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** Minutes after midnight (report zone) of an instant. */
function zoneMinutes(at: Date, tzOffsetMinutes: number): number {
  const local = new Date(at.getTime() + tzOffsetMinutes * 60_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes() + local.getUTCSeconds() / 60;
}

/** One employee's record for one day from the sessions that started that day. */
export function dayRecord(input: {
  date: string;
  today: string;
  joinedOn: string;
  /** First day any attendance was ever recorded; earlier days cannot be absences. Null = nothing recorded yet. */
  trackingStartedOn: string | null;
  sessions: SessionForDay[];
  /** That day's calls, counted the same way as the sales reports (talk time = connected calls only). */
  callStats?: DayCalls;
  now: Date;
  tzOffsetMinutes: number;
}): DayRecord {
  const { date, today, joinedOn, trackingStartedOn, now, tzOffsetMinutes } = input;
  const sessions = [...input.sessions].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const empty: DayRecord = {
    date,
    status: "ABSENT",
    checkIn: null,
    checkOut: null,
    stillWorking: false,
    workingMs: 0,
    productiveMs: 0,
    breakMs: 0,
    sessions: 0,
    calls: input.callStats?.calls ?? 0,
    talkTimeSec: input.callStats?.talkTimeSec ?? 0,
    remarks: [],
  };

  if (sessions.length === 0) {
    if (date < joinedOn) return { ...empty, status: "NOT_JOINED", remarks: [`Joined ${joinedOn}`] };
    if (!trackingStartedOn || date < trackingStartedOn) return { ...empty, status: "NOT_TRACKED", remarks: ["Before attendance tracking began"] };
    if (date > today) return { ...empty, status: "PENDING" };
    if (date === today && zoneMinutes(now, tzOffsetMinutes) <= ATTENDANCE_CUTOFF_MINUTES) return { ...empty, status: "PENDING", remarks: ["Not clocked in yet"] };
    return { ...empty, remarks: ["No clock-in recorded"] };
  }

  const first = sessions[0]!;
  const open = sessions.some((s) => !s.endedAt);
  const summary = mergeSummaries(sessions.map((s) => computeSummary(s.logs, s.startedAt, s.endedAt ?? now)));
  const last = sessions[sessions.length - 1]!;

  const remarks: string[] = [];
  if (open) remarks.push("Still working");
  if (sessions.some((s) => s.endReason === SessionEndReason.STALE)) remarks.push("Auto clocked out (no activity)");
  if (sessions.length > 1) remarks.push(`${sessions.length} sessions`);
  if (summary.breakTotalMs > BREAK_LIMIT_MS) remarks.push("Breaks over 1h limit");
  if (date < joinedOn) remarks.push(`Before joining date ${joinedOn}`);

  return {
    date,
    status: "PRESENT",
    checkIn: first.startedAt.toISOString(),
    checkOut: open ? null : (last.endedAt?.toISOString() ?? null),
    stillWorking: open,
    workingMs: summary.shiftElapsedMs,
    productiveMs: summary.productiveMs,
    breakMs: summary.breakTotalMs,
    sessions: sessions.length,
    calls: input.callStats?.calls ?? 0,
    talkTimeSec: input.callStats?.talkTimeSec ?? 0,
    remarks,
  };
}

export function matchesStatus(status: DayStatus, filter: StatusFilter): boolean {
  return filter === "ALL" || status === filter;
}

export interface AttendanceTotals {
  present: number;
  absent: number;
  /** Eligible working days: present + absent (excludes today before the cut-off, pre-joining and pre-tracking days). */
  expected: number;
  /** Same as present (kept so totals read "attended of expected"). */
  attended: number;
  workingMs: number;
  productiveMs: number;
  calls: number;
  talkTimeSec: number;
  /** attended / expected, 0..100, null when nothing was expected. */
  attendancePct: number | null;
}

export function totalsOf(records: DayRecord[]): AttendanceTotals {
  const present = records.filter((r) => r.status === "PRESENT").length;
  const absent = records.filter((r) => r.status === "ABSENT").length;
  const expected = present + absent;
  return {
    present,
    absent,
    expected,
    attended: present,
    workingMs: records.reduce((a, r) => a + r.workingMs, 0),
    productiveMs: records.reduce((a, r) => a + r.productiveMs, 0),
    calls: records.reduce((a, r) => a + r.calls, 0),
    talkTimeSec: records.reduce((a, r) => a + r.talkTimeSec, 0),
    attendancePct: expected > 0 ? Math.round((present / expected) * 1000) / 10 : null,
  };
}

