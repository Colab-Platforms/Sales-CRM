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

export const STATUS_COLORS: Record<LeadWorkingStatus, string> = {
  NEW: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  ASSIGNED: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  WORKING: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  INTERESTED: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  EXPIRED: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  CONVERTED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  CLOSED: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
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
