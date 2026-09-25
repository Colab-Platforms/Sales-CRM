import type { WhatsAppTemplateStatus } from "./api-client/types/whatsapp-templates.types";

export const TEMPLATE_STATUS_LABELS: Record<WhatsAppTemplateStatus, string> = {
  DRAFT: "Draft",
  PENDING: "Pending review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  DISABLED: "Disabled",
};

export const TEMPLATE_STATUS_COLORS: Record<WhatsAppTemplateStatus, string> = {
  DRAFT: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  PENDING: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  APPROVED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  REJECTED: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  DISABLED: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 line-through",
};

export const TEMPLATE_STATUS_ORDER: WhatsAppTemplateStatus[] = ["DRAFT", "PENDING", "APPROVED", "REJECTED", "DISABLED"];

export const PROVIDER_LABELS: Record<string, string> = { AISENSY: "AiSensy", GUPSHUP: "Gupshup", META: "Meta Cloud API" };
