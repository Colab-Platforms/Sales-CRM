import type { CallStatus } from "./api-client/types/calls.types";
import type { CallDirection } from "./api-client/types/call-history.types";

export const CALL_STATUS_LABELS: Record<CallStatus, string> = {
  INITIATED: "Initiated",
  RINGING_AGENT: "Ringing agent",
  AGENT_ANSWERED: "Agent answered",
  RINGING_CUSTOMER: "Ringing customer",
  CONNECTED: "Connected",
  COMPLETED: "Completed",
  NO_ANSWER: "No answer",
  BUSY: "Busy",
  NOT_REACHABLE: "Not reachable",
  FAILED: "Failed",
};

export const CALL_STATUS_COLORS: Record<CallStatus, string> = {
  INITIATED: "bg-blue-600/12 text-blue-700 border-blue-600/35 dark:text-blue-300",
  RINGING_AGENT: "bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300",
  AGENT_ANSWERED: "bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300",
  RINGING_CUSTOMER: "bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300",
  CONNECTED: "bg-cyan-500/12 text-cyan-700 border-cyan-500/35 dark:text-cyan-300",
  COMPLETED: "bg-emerald-600/12 text-emerald-700 border-emerald-600/35 dark:text-emerald-300",
  NO_ANSWER: "bg-zinc-400/15 text-zinc-600 border-zinc-400/40 dark:text-zinc-300",
  BUSY: "bg-orange-500/12 text-orange-700 border-orange-500/35 dark:text-orange-300",
  NOT_REACHABLE: "bg-zinc-400/15 text-zinc-600 border-zinc-400/40 dark:text-zinc-300",
  FAILED: "bg-rose-600/12 text-rose-700 border-rose-600/35 dark:text-rose-300",
};

export const CALL_STATUS_ORDER: CallStatus[] = [
  "INITIATED",
  "RINGING_AGENT",
  "AGENT_ANSWERED",
  "RINGING_CUSTOMER",
  "CONNECTED",
  "COMPLETED",
  "NO_ANSWER",
  "BUSY",
  "NOT_REACHABLE",
  "FAILED",
];

export const CALL_DIRECTION_LABELS: Record<CallDirection, string> = {
  INBOUND: "Inbound",
  OUTBOUND: "Outbound",
};

export function formatCallDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
