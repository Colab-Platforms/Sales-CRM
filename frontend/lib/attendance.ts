import type { AttendanceSummary, WorkStatus } from "@/lib/api-client/types/attendance.types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Mirrors backend/src/modules/attendance/attendance.constants.ts.
export const SHIFT_MS = 9 * HOUR;
export const BREAK_LIMIT_MS = 1 * HOUR;
export const PRODUCTIVE_TARGET_MS = 8 * HOUR;

export const STATUS_LABEL: Record<WorkStatus, string> = {
  ACTIVE: "Active",
  ON_CALL: "On call",
  TEA_BREAK: "Tea break",
  LUNCH_BREAK: "Lunch break",
  BIO_BREAK: "Bio break",
  TEAM_HUDDLE: "Team huddle",
  IDLE: "Idle",
  OFFLINE: "Offline",
};

/** Dot colour per status (Tailwind classes), shared by the header widget and the team board. */
export const STATUS_DOT: Record<WorkStatus, string> = {
  ACTIVE: "bg-emerald-500",
  ON_CALL: "bg-primary",
  TEA_BREAK: "bg-amber-500",
  LUNCH_BREAK: "bg-amber-500",
  BIO_BREAK: "bg-amber-500",
  TEAM_HUDDLE: "bg-teal-500",
  IDLE: "bg-orange-500",
  OFFLINE: "bg-muted-foreground/50",
};

export function isBreak(status: WorkStatus): boolean {
  return status === "TEA_BREAK" || status === "LUNCH_BREAK" || status === "BIO_BREAK";
}

/**
 * The server sends a summary as of the moment it answered. Between refetches the browser adds the
 * time since then to whichever bucket the current status feeds, so the clocks tick without polling.
 */
export function tickSummary(summary: AttendanceSummary, status: WorkStatus, deltaMs: number): AttendanceSummary {
  const d = Math.max(0, deltaMs);
  const next = { ...summary, shiftElapsedMs: summary.shiftElapsedMs + d };

  if (status === "TEA_BREAK") next.teaMs += d;
  if (status === "LUNCH_BREAK") next.lunchMs += d;
  if (status === "BIO_BREAK") next.bioMs += d;
  if (isBreak(status)) next.breakTotalMs += d;
  if (status === "TEAM_HUDDLE") next.huddleMs += d;
  if (status === "ON_CALL") next.callingMs += d;
  if (status === "IDLE") next.idleMs += d;

  next.shiftRemainingMs = Math.max(0, SHIFT_MS - next.shiftElapsedMs);
  next.shiftOverrunMs = Math.max(0, next.shiftElapsedMs - SHIFT_MS);
  next.breakRemainingMs = Math.max(0, BREAK_LIMIT_MS - next.breakTotalMs);
  next.breakOverageMs = Math.max(0, next.breakTotalMs - BREAK_LIMIT_MS);
  next.productiveMs = Math.max(0, next.shiftElapsedMs - next.breakTotalMs - next.huddleMs);
  next.targetMet = next.productiveMs >= PRODUCTIVE_TARGET_MS;
  return next;
}

/** 3725000 -> "1:02:05" */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 5400000 -> "1h 30m" (for reports, where seconds are noise) */
export function formatHours(ms: number): string {
  const totalMinutes = Math.round(Math.max(0, ms) / MINUTE);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Today as YYYY-MM-DD in the reporting zone (India), matching the server's day cut. */
export function todayInReportZone(): string {
  return new Date(Date.now() + 330 * MINUTE).toISOString().slice(0, 10);
}
