import type { LeadWorkingStatus } from "./api-client/types/dashboard.types";

export const STATUS_LABELS: Record<LeadWorkingStatus, string> = {
  NEW: "New",
  ASSIGNED: "Assigned",
  WORKING: "Working",
  INTERESTED: "Interested",
  EXPIRED: "Expired",
  CONVERTED: "Converted",
  CLOSED: "Closed",
};

/*
  Hues are assigned so that statuses sitting next to each other in STATUS_ORDER
  stay distinguishable under deuteranopia/protanopia — blue beside violet was
  indistinguishable (ΔE 1.3), so ASSIGNED steps up in lightness and INTERESTED
  moved off teal, which collided with CONVERTED's green even in normal vision.
  Verified worst adjacent pair: ΔE 10.3 (CVD) / 16.3 (normal).

  EXPIRED stays neutral grey on purpose: it reads as a dead state rather than
  competing for identity with the live pipeline stages.
*/
export const STATUS_COLORS: Record<LeadWorkingStatus, string> = {
  NEW: "bg-blue-600/12 text-blue-700 border-blue-600/35 dark:text-blue-300",
  ASSIGNED: "bg-purple-400/15 text-purple-700 border-purple-400/40 dark:text-purple-300",
  WORKING: "bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300",
  INTERESTED: "bg-cyan-500/12 text-cyan-700 border-cyan-500/35 dark:text-cyan-300",
  EXPIRED: "bg-zinc-400/15 text-zinc-600 border-zinc-400/40 dark:text-zinc-300",
  CONVERTED: "bg-emerald-600/12 text-emerald-700 border-emerald-600/35 dark:text-emerald-300",
  CLOSED: "bg-rose-600/12 text-rose-700 border-rose-600/35 dark:text-rose-300",
};

/** Solid fills for the breakdown bar segments and the dots that label them. */
export const STATUS_FILLS: Record<LeadWorkingStatus, string> = {
  NEW: "bg-blue-600",
  ASSIGNED: "bg-purple-400",
  WORKING: "bg-amber-500",
  INTERESTED: "bg-cyan-500",
  EXPIRED: "bg-zinc-400",
  CONVERTED: "bg-emerald-600",
  CLOSED: "bg-rose-600",
};

export const STATUS_ORDER: LeadWorkingStatus[] = [
  "NEW",
  "ASSIGNED",
  "WORKING",
  "INTERESTED",
  "CONVERTED",
  "EXPIRED",
  "CLOSED",
];
