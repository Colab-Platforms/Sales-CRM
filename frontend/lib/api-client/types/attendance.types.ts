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

/** Max salespeople under a manager allowed on a break at once; null = no cap. */
export interface BreakLimit {
  managerId: string;
  maxConcurrentBreaks: number | null;
}

// ---- Attendance records (filters & reports) ----

export type DayStatus = "PRESENT" | "LATE" | "ABSENT" | "PENDING" | "NOT_JOINED" | "NOT_TRACKED";
export type AttendanceStatusFilter = "ALL" | "PRESENT" | "LATE" | "ABSENT";

export interface AttendanceDayRecord {
  date: string;
  status: DayStatus;
  checkIn: string | null;
  checkOut: string | null;
  stillWorking: boolean;
  workingMs: number;
  productiveMs: number;
  breakMs: number;
  lateByMs: number;
  sessions: number;
  calls: number;
  talkTimeSec: number;
  remarks: string[];
}

export interface AttendanceTotals {
  present: number;
  late: number;
  absent: number;
  expected: number;
  attended: number;
  workingMs: number;
  productiveMs: number;
  calls: number;
  talkTimeSec: number;
  attendancePct: number | null;
}

export interface AttendanceRecordsQuery {
  from: string;
  to: string;
  userId?: string;
  status: AttendanceStatusFilter;
  page?: number;
  pageSize?: number;
}

export interface AttendanceRecords {
  range: { from: string; to: string; days: string[]; today: string; tzOffsetMinutes: number };
  filters: { userId: string | null; status: AttendanceStatusFilter };
  policy: { trackingStartedOn: string | null; lateAfter: string; weeklyOff: null; halfDay: boolean; leaveAndHolidays: boolean };
  summary: AttendanceTotals & { totalEmployees: number };
  daily: { date: string; present: number; late: number; absent: number; expected: number; attendancePct: number | null }[];
  employees: { id: string; name: string; employeeId: string; joinedOn: string; totals: AttendanceTotals; records: AttendanceDayRecord[] }[];
  pagination: { page: number; pageSize: number; pages: number; total: number };
  team: { id: string; name: string; employeeId: string }[];
}
