import { CallStatus, WorkStatus } from "../../../generated/prisma/enums.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const SHIFT_MS = 9 * HOUR;
export const BREAK_LIMIT_MS = 1 * HOUR;
export const PRODUCTIVE_TARGET_MS = 8 * HOUR;

// A dropped stream isn't treated as "gone" until it has stayed gone this long - covers Wi-Fi blips,
// browser reloads and server restarts/deploys.
export const DISCONNECT_GRACE_MS = 90_000;
export const PING_INTERVAL_MS = 25_000;
// A stream that stays "open" is not proof the person is there: a sleeping laptop or dropped Wi-Fi leaves
// the server-side socket open for minutes. The browser also POSTs a heartbeat; no beat for this long
// means the connection is treated as dead even though the socket hasn't closed.
export const HEARTBEAT_TIMEOUT_MS = 120_000;
export const SWEEP_INTERVAL_MS = 60_000;
// No browser seen for this long: the shift is closed at the last moment we saw them.
export const STALE_SESSION_MS = 30 * MINUTE;
// ON_CALL is set when the call starts and cleared by the CallerDesk webhook; if that webhook never
// arrives, don't leave the salesperson stuck "on a call".
export const MAX_ON_CALL_MS = 30 * MINUTE;

// Reports/"today" are cut at midnight in this zone (the team works Indian hours; the server runs in UTC).
export const REPORT_TZ_OFFSET_MINUTES = 330;

export const BREAK_STATUSES: ReadonlySet<WorkStatus> = new Set([
  WorkStatus.TEA_BREAK,
  WorkStatus.LUNCH_BREAK,
  WorkStatus.BIO_BREAK,
]);

// Statuses a salesperson may pick themselves. ON_CALL / IDLE / OFFLINE are set by the system only.
export const MANUAL_STATUSES: ReadonlySet<WorkStatus> = new Set([
  WorkStatus.ACTIVE,
  WorkStatus.TEA_BREAK,
  WorkStatus.LUNCH_BREAK,
  WorkStatus.BIO_BREAK,
  WorkStatus.TEAM_HUDDLE,
]);

// A call in one of these states is over, so the agent's shift status goes back from ON_CALL.
export const ENDED_CALL_STATUSES: ReadonlySet<CallStatus> = new Set([
  CallStatus.COMPLETED,
  CallStatus.NO_ANSWER,
  CallStatus.BUSY,
  CallStatus.NOT_REACHABLE,
  CallStatus.FAILED,
]);
