import type { ReconciliationStatus } from "./api-client/types/reconciliation.types";

export const RECONCILIATION_STATUS_LABELS: Record<ReconciliationStatus, string> = {
  PAID: "Paid",
  PARTIALLY_PAID: "Partially paid",
  PENDING: "Pending",
  FAILED: "Failed",
  REFUNDED: "Refunded",
  PAYMENT_MISMATCH: "Payment mismatch",
};

export const RECONCILIATION_STATUS_COLORS: Record<ReconciliationStatus, string> = {
  PAID: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  PARTIALLY_PAID: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  PENDING: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  FAILED: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  REFUNDED: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
  PAYMENT_MISMATCH: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
};

export const RECONCILIATION_STATUS_ORDER: ReconciliationStatus[] = [
  "PAID",
  "PARTIALLY_PAID",
  "PENDING",
  "FAILED",
  "REFUNDED",
  "PAYMENT_MISMATCH",
];
