import { CallStatus } from "@root/generated/prisma/enums.js";

/**
 * CallerDesk `Status` -> internal `CallStatus`.
 *
 * Source: CallerDesk docs "Incoming call reports status" and "Outgoing call
 * reports status". Only documented values are mapped; anything else is
 * reported as unrecognised (`status: null`) and the caller applies a safe
 * fallback. CallerDesk-specific values must never reach the frontend.
 *
 * Known ambiguity in the docs: the "Leg A Answer" / "Leg B Answer" rows share
 * the same (copy-pasted) description. For a Live event we treat Leg A as
 * "agent answered" and Leg B as "customer connected"; in a final Call Report
 * we treat both as a completed (answered) call.
 */

export type CallerDeskEventKind = "CALL_REPORT" | "LIVE_CALL";

export interface MappedStatus {
  status: CallStatus | null;
  failedLeg: "AGENT" | "CUSTOMER" | null;
  recognised: boolean;
}

interface Entry {
  live: CallStatus;
  report: CallStatus;
}

const same = (status: CallStatus): Entry => ({ live: status, report: status });

/** Keys are upper-cased with everything except A-Z0-9 removed and any "(...)" suffix stripped. */
const TABLE: Record<string, Entry> = {
  // Incoming + generic
  ANSWER: { live: CallStatus.CONNECTED, report: CallStatus.COMPLETED },
  ANSWERED: { live: CallStatus.CONNECTED, report: CallStatus.COMPLETED },
  CANCEL: same(CallStatus.NO_ANSWER), // hung up before being picked up
  NOANSWER: same(CallStatus.NO_ANSWER),
  BUSY: same(CallStatus.BUSY),
  CONGESTION: same(CallStatus.FAILED), // network problem, number not recognised
  UNAVAILABLE: same(CallStatus.NOT_REACHABLE),
  CHANUNAVAIL: same(CallStatus.FAILED), // SIP channel unavailable
  NOTCONNECTED: same(CallStatus.NO_ANSWER), // reached IVR, never forwarded to an agent
  AGENTENGAGED: same(CallStatus.BUSY), // agent on another call
  AGENTONRING: same(CallStatus.BUSY), // agent ringing for another call
  ABANDONEDCALL: same(CallStatus.NO_ANSWER), // caller left while no agent answered
  ABANDONED: same(CallStatus.NO_ANSWER),
  TRANSFERTOAGENT: same(CallStatus.RINGING_AGENT),
  PICKED: same(CallStatus.AGENT_ANSWERED),

  // Outgoing (click-to-call: Leg A = agent, Leg B = customer)
  LEGAANSWER: { live: CallStatus.AGENT_ANSWERED, report: CallStatus.COMPLETED },
  LEGBANSWER: { live: CallStatus.CONNECTED, report: CallStatus.COMPLETED },
};

const LEG_CANCEL_PATTERN = /^LEG([AB])CANCEL(?:AGENT|CUSTOMER)?(NOANSWER|BUSY|CONGESTION|UNAVAILABLE)$/;

const LEG_CANCEL_STATUS: Record<string, CallStatus> = {
  NOANSWER: CallStatus.NO_ANSWER,
  BUSY: CallStatus.BUSY,
  CONGESTION: CallStatus.FAILED,
  UNAVAILABLE: CallStatus.NOT_REACHABLE,
};

export function normalizeStatusKey(rawStatus: string): string {
  return rawStatus
    .replace(/\(.*?\)/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function mapCallerDeskStatus(rawStatus: string | null, kind: CallerDeskEventKind): MappedStatus {
  if (!rawStatus) return { status: null, failedLeg: null, recognised: false };

  const key = normalizeStatusKey(rawStatus);
  if (!key) return { status: null, failedLeg: null, recognised: false };

  const entry = TABLE[key];
  if (entry) {
    return { status: kind === "LIVE_CALL" ? entry.live : entry.report, failedLeg: null, recognised: true };
  }

  const legMatch = LEG_CANCEL_PATTERN.exec(key);
  if (legMatch) {
    const status = LEG_CANCEL_STATUS[legMatch[2]!];
    if (status) {
      return { status, failedLeg: legMatch[1] === "A" ? "AGENT" : "CUSTOMER", recognised: true };
    }
  }

  return { status: null, failedLeg: null, recognised: false };
}

const TERMINAL: ReadonlySet<CallStatus> = new Set<CallStatus>([
  CallStatus.COMPLETED,
  CallStatus.NO_ANSWER,
  CallStatus.BUSY,
  CallStatus.NOT_REACHABLE,
  CallStatus.FAILED,
]);

export function isTerminalCallStatus(status: CallStatus): boolean {
  return TERMINAL.has(status);
}

/** Forward-only ordering for non-terminal states. Terminal states share the top rank. */
const RANK: Record<CallStatus, number> = {
  INITIATED: 0,
  RINGING_AGENT: 1,
  AGENT_ANSWERED: 2,
  RINGING_CUSTOMER: 3,
  CONNECTED: 4,
  COMPLETED: 10,
  NO_ANSWER: 10,
  BUSY: 10,
  NOT_REACHABLE: 10,
  FAILED: 10,
};

export function callStatusRank(status: CallStatus): number {
  return RANK[status];
}
