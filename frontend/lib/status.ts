import type { LeadWorkingStatus } from "./api-client/types/dashboard.types";

export const STATUS_LABELS: Record<LeadWorkingStatus, string> = {
  NEW: "New",
  ASSIGNED: "Assigned",
  RINGING: "Ringing",
  BUSY: "Busy",
  CALL_BACK: "Call back",
  FOLLOW_UP: "Follow up",
  SWITCHED_OFF: "Switched off",
  DND: "DND",
  NOT_REACHABLE: "Not reachable",
  INTERESTED: "Interested",
  NOT_INTERESTED: "Not interested",
  CONVERTED: "Converted",
};

/*
  Hues are assigned so that statuses sitting next to each other in STATUS_ORDER
  stay distinguishable under deuteranopia/protanopia — blue beside violet was
  indistinguishable (ΔE 1.3), so ASSIGNED steps up in lightness and INTERESTED
  moved off teal, which collided with CONVERTED's green even in normal vision.
  Verified worst adjacent pair: ΔE 10.3 (CVD) / 16.3 (normal).

  SWITCHED_OFF stays neutral grey on purpose: it reads as a dead-end call result
  rather than competing for identity with the live pipeline stages.
  Adjacent-pair contrast for the new call-outcome hues has not been re-verified
  under CVD like the original set was.
*/
export const STATUS_COLORS: Record<LeadWorkingStatus, string> = {
  NEW: "bg-blue-600/12 text-blue-700 border-blue-600/35 dark:text-blue-300",
  ASSIGNED: "bg-purple-400/15 text-purple-700 border-purple-400/40 dark:text-purple-300",
  RINGING: "bg-sky-500/12 text-sky-700 border-sky-500/35 dark:text-sky-300",
  BUSY: "bg-orange-500/12 text-orange-700 border-orange-500/35 dark:text-orange-300",
  CALL_BACK: "bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300",
  FOLLOW_UP: "bg-yellow-500/15 text-yellow-700 border-yellow-500/40 dark:text-yellow-300",
  SWITCHED_OFF: "bg-zinc-400/15 text-zinc-600 border-zinc-400/40 dark:text-zinc-300",
  DND: "bg-rose-600/12 text-rose-700 border-rose-600/35 dark:text-rose-300",
  NOT_REACHABLE: "bg-slate-500/15 text-slate-700 border-slate-500/40 dark:text-slate-300",
  INTERESTED: "bg-cyan-500/12 text-cyan-700 border-cyan-500/35 dark:text-cyan-300",
  NOT_INTERESTED: "bg-red-600/12 text-red-700 border-red-600/35 dark:text-red-300",
  CONVERTED: "bg-emerald-600/12 text-emerald-700 border-emerald-600/35 dark:text-emerald-300",
};

/** Solid fills for the breakdown bar segments and the dots that label them. */
export const STATUS_FILLS: Record<LeadWorkingStatus, string> = {
  NEW: "bg-blue-600",
  ASSIGNED: "bg-purple-400",
  RINGING: "bg-sky-500",
  BUSY: "bg-orange-500",
  CALL_BACK: "bg-amber-500",
  FOLLOW_UP: "bg-yellow-500",
  SWITCHED_OFF: "bg-zinc-400",
  DND: "bg-rose-600",
  NOT_REACHABLE: "bg-slate-500",
  INTERESTED: "bg-cyan-500",
  NOT_INTERESTED: "bg-red-600",
  CONVERTED: "bg-emerald-600",
};

export const STATUS_ORDER: LeadWorkingStatus[] = [
  "NEW",
  "ASSIGNED",
  "RINGING",
  "BUSY",
  "CALL_BACK",
  "FOLLOW_UP",
  "SWITCHED_OFF",
  "DND",
  "NOT_REACHABLE",
  "INTERESTED",
  "NOT_INTERESTED",
  "CONVERTED",
];
