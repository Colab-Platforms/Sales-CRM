import type { CustomerSegment } from "./api-client/types/customers.types";

export const CUSTOMER_SEGMENT_LABELS: Record<CustomerSegment, string> = {
  NEW: "New",
  HOT: "Hot",
  REPEAT: "Repeat",
  VIP: "VIP",
  DORMANT: "Dormant",
  AT_RISK: "At risk",
};

export const CUSTOMER_SEGMENT_COLORS: Record<CustomerSegment, string> = {
  NEW: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  HOT: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  REPEAT: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  VIP: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  DORMANT: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  AT_RISK: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

export const CUSTOMER_SEGMENT_ORDER: CustomerSegment[] = ["NEW", "HOT", "REPEAT", "VIP", "DORMANT", "AT_RISK"];
