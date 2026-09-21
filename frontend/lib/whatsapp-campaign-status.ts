import type { WhatsAppCampaignRecipientStatus, WhatsAppCampaignStatus } from "@/lib/api-client/types/whatsapp-campaigns.types";

export const CAMPAIGN_STATUS_LABELS: Record<WhatsAppCampaignStatus, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  RUNNING: "Running",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

export const CAMPAIGN_STATUS_COLORS: Record<WhatsAppCampaignStatus, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SCHEDULED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  RUNNING: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  COMPLETED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  CANCELLED: "bg-muted text-muted-foreground",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export const RECIPIENT_STATUS_LABELS: Record<WhatsAppCampaignRecipientStatus, string> = {
  PENDING: "Pending",
  CLAIMED: "Sending",
  SENT: "Sent",
  SKIPPED: "Skipped",
  FAILED: "Failed",
};

export const RECIPIENT_STATUS_COLORS: Record<WhatsAppCampaignRecipientStatus, string> = {
  PENDING: "bg-muted text-muted-foreground",
  CLAIMED: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  SENT: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  SKIPPED: "bg-muted text-muted-foreground",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};
