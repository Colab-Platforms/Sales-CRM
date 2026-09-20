import type { ActivitySource, ActivityType } from "./api-client/types/audit.types";

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  LEAD_CREATED: "Lead created",
  LEAD_UPDATED: "Lead updated",
  ASSIGNMENT: "Assigned",
  REASSIGNMENT: "Reassigned",
  CALL: "Call",
  NOTE: "Note",
  STATUS_CHANGE: "Status changed",
  INTERESTED: "Marked interested",
  INTERESTED_EXPIRED: "Interest expired",
  ORDER_CREATED: "Order created",
  ORDER_CONFIRMED: "Order confirmed",
  PAYMENT: "Payment update",
  ABANDONMENT: "Abandonment",
  RECOVERY: "Recovery action",
  TASK: "Task",
  ORDER_STATUS_CHANGED: "Order status changed",
  ORDER_CANCELLED: "Order cancelled",
  PAYMENT_CREATED: "Payment recorded",
  PAYMENT_STATUS_CHANGED: "Payment status changed",
  PAYMENT_REFUNDED: "Payment refunded",
  PAYMENT_MISMATCH_DETECTED: "Payment mismatch detected",
  SHIPMENT_CREATED: "Shipment created",
  SHIPMENT_STATUS_CHANGED: "Shipment status changed",
  TRACKING_UPDATED: "Tracking updated",
  DISCOUNT_CHANGED: "Discount changed",
};

// Only the types the E6.6 Audit Trail actually writes going forward are offered as filter options;
// legacy-only types (STATUS_CHANGE, PAYMENT) still render correctly wherever they appear historically.
export const AUDIT_FILTERABLE_TYPES: ActivityType[] = [
  "LEAD_CREATED",
  "LEAD_UPDATED",
  "ASSIGNMENT",
  "REASSIGNMENT",
  "ORDER_CREATED",
  "ORDER_CONFIRMED",
  "ORDER_STATUS_CHANGED",
  "ORDER_CANCELLED",
  "PAYMENT_CREATED",
  "PAYMENT_STATUS_CHANGED",
  "PAYMENT_REFUNDED",
  "PAYMENT_MISMATCH_DETECTED",
  "SHIPMENT_CREATED",
  "SHIPMENT_STATUS_CHANGED",
  "TRACKING_UPDATED",
  "DISCOUNT_CHANGED",
];

export const ACTIVITY_TYPE_COLORS: Record<ActivityType, string> = {
  LEAD_CREATED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  LEAD_UPDATED: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  ASSIGNMENT: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  REASSIGNMENT: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  CALL: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  NOTE: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  STATUS_CHANGE: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  INTERESTED: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  INTERESTED_EXPIRED: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  ORDER_CREATED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  ORDER_CONFIRMED: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  PAYMENT: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  ABANDONMENT: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  RECOVERY: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  TASK: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  ORDER_STATUS_CHANGED: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  ORDER_CANCELLED: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  PAYMENT_CREATED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  PAYMENT_STATUS_CHANGED: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  PAYMENT_REFUNDED: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
  PAYMENT_MISMATCH_DETECTED: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  SHIPMENT_CREATED: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  SHIPMENT_STATUS_CHANGED: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  TRACKING_UPDATED: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  DISCOUNT_CHANGED: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

export const ACTIVITY_SOURCE_LABELS: Record<ActivitySource, string> = {
  USER: "CRM user",
  SHOPIFY_SYNC: "Shopify sync",
  SHOPIFY_WEBHOOK: "Shopify webhook",
  SYSTEM: "System",
};

export const ACTIVITY_SOURCE_ORDER: ActivitySource[] = ["USER", "SHOPIFY_SYNC", "SHOPIFY_WEBHOOK", "SYSTEM"];
