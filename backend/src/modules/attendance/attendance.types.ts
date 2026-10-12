import type { WorkStatus } from "../../../generated/prisma/enums.js";

export interface SetStatusBody {
  status: WorkStatus;
}

export interface ReportQuery {
  date?: string;
  userId?: string;
}

export interface LogInterval {
  status: WorkStatus;
  startedAt: Date;
  endedAt: Date | null;
}

// All durations are milliseconds.
export interface AttendanceSummary {
  shiftElapsedMs: number;
  shiftRemainingMs: number;
  shiftOverrunMs: number;
  teaMs: number;
  lunchMs: number;
  bioMs: number;
  breakTotalMs: number;
  breakRemainingMs: number;
  breakOverageMs: number;
  huddleMs: number;
  callingMs: number;
  idleMs: number;
  productiveMs: number;
  productiveTargetMs: number;
  targetMet: boolean;
}

export interface StatusEvent {
  type: "status";
  userId: string;
  name: string;
  managerId: string | null;
  status: WorkStatus;
  statusSince: string;
  sessionEnded: boolean;
}
