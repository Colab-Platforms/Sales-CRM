import type { NbaAction, NbaPriority } from "./api-client/types/customers.types";

export const NBA_ACTION_LABELS: Record<NbaAction, string> = {
  FOLLOW_UP_PAYMENT: "Follow up payment",
  TRACK_SHIPMENT: "Track shipment",
  FOLLOW_UP_DELIVERY: "Follow up delivery",
  HANDLE_RETURN: "Handle return",
  RETENTION_FOLLOW_UP: "Retention follow-up",
  REPEAT_PURCHASE_FOLLOW_UP: "Repeat purchase follow-up",
  HIGH_VALUE_CUSTOMER_FOLLOW_UP: "High-value customer follow-up",
  INTERESTED_LEAD_FOLLOW_UP: "Interested lead follow-up",
  GENERAL_FOLLOW_UP: "General follow-up",
  NO_ACTION: "No action",
};

export const NBA_ACTION_ORDER: NbaAction[] = [
  "FOLLOW_UP_PAYMENT",
  "FOLLOW_UP_DELIVERY",
  "HANDLE_RETURN",
  "TRACK_SHIPMENT",
  "INTERESTED_LEAD_FOLLOW_UP",
  "RETENTION_FOLLOW_UP",
  "REPEAT_PURCHASE_FOLLOW_UP",
  "HIGH_VALUE_CUSTOMER_FOLLOW_UP",
  "GENERAL_FOLLOW_UP",
  "NO_ACTION",
];

export const NBA_ACTION_COLORS: Record<NbaAction, string> = {
  FOLLOW_UP_PAYMENT: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  FOLLOW_UP_DELIVERY: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  HANDLE_RETURN: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  TRACK_SHIPMENT: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  RETENTION_FOLLOW_UP: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  REPEAT_PURCHASE_FOLLOW_UP: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  HIGH_VALUE_CUSTOMER_FOLLOW_UP: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  INTERESTED_LEAD_FOLLOW_UP: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
  GENERAL_FOLLOW_UP: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  NO_ACTION: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
};

export const NBA_PRIORITY_LABELS: Record<NbaPriority, string> = {
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  NONE: "—",
};

export const NBA_PRIORITY_ORDER: NbaPriority[] = ["HIGH", "MEDIUM", "LOW", "NONE"];

export const NBA_PRIORITY_COLORS: Record<NbaPriority, string> = {
  HIGH: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  MEDIUM: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  LOW: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  NONE: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
};
