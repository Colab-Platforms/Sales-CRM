export type MatrixRag = "GREEN" | "AMBER" | "RED";
export type MatrixState = MatrixRag | "IN_PROGRESS" | "UPCOMING" | "OFF_SHIFT" | "NO_DATA";

export interface MatrixHour {
  key: string;
  calls: number;
  orders: number;
  clockedInMinutes: number;
  state: MatrixState;
  reason: string;
}

export interface MatrixRow {
  id: string;
  name: string;
  employeeId: string;
  managerId: string | null;
  hours: MatrixHour[];
  outside: { calls: number; orders: number };
  totals: { calls: number; orders: number };
  /** Minutes logged in over the whole day, login to logout. */
  clockedInMinutes: number;
  loginAt: string | null;
  /** Null while still logged in, or with no session. */
  logoutAt: string | null;
  stillLoggedIn: boolean;
  callsPerHour: number | null;
  status: MatrixState;
  reason: string;
}

export interface PerformanceMatrix {
  date: string;
  today: string;
  isToday: boolean;
  generatedAt: string;
  tzOffsetMinutes: number;
  dataAvailable: boolean;
  filters: { salespersonId: string | null; managerId: string | null };
  team: { id: string; name: string }[];
  managers: { id: string; name: string }[];
  /** teamCallsPerHour: the team's average calls per clocked-in hour in that slot (the benchmark for its colours). */
  slots: { key: string; start: string; end: string; teamCallsPerHour: number }[];
  /** The team's average calls per clocked-in hour over the day (the benchmark for the daily colours). */
  teamCallsPerHour: number;
  summary: { totalCalls: number; totalOrders: number; salespeople: number; needAttention: number; byStatus: Record<MatrixRag, number> };
  rows: MatrixRow[];
}

export interface MatrixQuery {
  date: string;
  salespersonId?: string;
  managerId?: string;
}
