export type WorkStatus =
  | "ACTIVE"
  | "ON_CALL"
  | "TEA_BREAK"
  | "LUNCH_BREAK"
  | "BIO_BREAK"
  | "TEAM_HUDDLE"
  | "IDLE"
  | "OFFLINE";

/** Statuses a salesperson can pick themselves; ON_CALL / IDLE / OFFLINE are set by the system. */
export type ManualWorkStatus = Extract<WorkStatus, "ACTIVE" | "TEA_BREAK" | "LUNCH_BREAK" | "BIO_BREAK" | "TEAM_HUDDLE">;

/** All durations are milliseconds. */
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

export interface WorkSessionView {
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: WorkStatus;
  statusSince: string;
  summary: AttendanceSummary;
}

export interface MyShift {
  session: WorkSessionView | null;
  serverTime: string;
}

export interface TeamMemberStatus {
  userId: string;
  name: string;
  username: string;
  managerId: string | null;
  status: WorkStatus;
  statusSince: string | null;
  shiftStartedAt: string | null;
  summary: AttendanceSummary | null;
}

export interface TeamStatus {
  serverTime: string;
  members: TeamMemberStatus[];
}

export interface AttendanceReportRow {
  userId: string;
  name: string;
  username: string;
  firstLoginAt: string | null;
  lastLogoutAt: string | null;
  sessions: WorkSessionView[];
  summary: AttendanceSummary | null;
}

export interface AttendanceReport {
  date: string;
  rows: AttendanceReportRow[];
}

/** Pushed over the SSE streams whenever a salesperson's status changes. */
export interface StatusEvent {
  type: "status";
  userId: string;
  name: string;
  managerId: string | null;
  status: WorkStatus;
  statusSince: string;
  sessionEnded: boolean;
}
