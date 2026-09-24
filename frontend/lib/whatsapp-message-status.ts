import type { WhatsAppMessageStatus } from "./api-client/types/whatsapp-history.types";

export const MESSAGE_STATUS_LABELS: Record<WhatsAppMessageStatus, string> = {
  QUEUED: "Queued",
  SENT: "Sent",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED: "Failed",
  RECEIVED: "Received",
};

export const MESSAGE_STATUS_COLORS: Record<WhatsAppMessageStatus, string> = {
  QUEUED: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  SENT: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  DELIVERED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  READ: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  FAILED: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  RECEIVED: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
};

// Simple filter set: "All" plus a direction pair plus the statuses that actually exist on
// WhatsAppMessageStatus - matches the E7.4 spec's own minimum filter list exactly.
export type MessageHistoryFilter = "ALL" | "INBOUND" | "OUTBOUND" | "SENT" | "DELIVERED" | "READ" | "FAILED";

export const MESSAGE_HISTORY_FILTER_LABELS: Record<MessageHistoryFilter, string> = {
  ALL: "All",
  INBOUND: "Incoming",
  OUTBOUND: "Outgoing",
  SENT: "Sent",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED: "Failed",
};
