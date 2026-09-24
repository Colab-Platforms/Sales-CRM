import type { LeadPriority, LeadWorkingStatus, TimelineEventType } from "./api-client/types/customers.types";

export const LEAD_STATUS_LABELS: Record<LeadWorkingStatus, string> = {
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

export const LEAD_STATUS_COLORS: Record<LeadWorkingStatus, string> = {
  NEW: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  ASSIGNED: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  RINGING: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  BUSY: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  CALL_BACK: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  FOLLOW_UP: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  SWITCHED_OFF: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  DND: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  NOT_REACHABLE: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  INTERESTED: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  NOT_INTERESTED: "bg-red-500/10 text-red-600 dark:text-red-400",
  CONVERTED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
};

export const LEAD_PRIORITY_LABELS: Record<LeadPriority, string> = {
  LOW: "Low priority",
  MEDIUM: "Medium priority",
  HIGH: "High priority",
};

export const TIMELINE_EVENT_LABELS: Record<TimelineEventType, string> = {
  LEAD_CREATED: "Lead created",
  ASSIGNMENT: "Assignment",
  REASSIGNMENT: "Reassignment",
  CALL: "Call",
  INTERESTED_STARTED: "Interested",
  INTERESTED_ENDED: "Interested period ended",
  TASK: "Follow-up",
  ORDER_CREATED: "Order created",
  ORDER_PLACED: "Order placed",
  ORDER_CONFIRMED: "Order confirmed",
  ORDER_STATUS_CHANGE: "Order status change",
  ORDER_CANCELLED: "Order cancelled",
  PAYMENT: "Payment",
  SHIPMENT_SHIPPED: "Shipped",
  SHIPMENT_DELIVERED: "Delivered",
  SHIPMENT_RETURNED: "Returned",
  ABANDONMENT: "Abandonment",
  ABANDONMENT_RECOVERED: "Abandonment recovered",
  RECOVERY_ACTION: "Recovery action",
};
