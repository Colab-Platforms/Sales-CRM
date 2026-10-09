import type { TicketCategory, TicketPriority, TicketStatus } from "./api-client/types/tickets.types";

export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  LEAD_ISSUE: "Lead issue",
  ORDER_PAYMENT: "Order / payment",
  WHATSAPP_CALLING: "WhatsApp / calling",
  LOGIN_ACCESS: "Login / access",
  TECHNICAL_BUG: "Technical bug",
  OTHER: "Other",
};

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "Urgent" };

export const TICKET_PRIORITY_STYLES: Record<TicketPriority, string> = {
  LOW: "bg-muted text-muted-foreground",
  MEDIUM: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  HIGH: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  URGENT: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = { OPEN: "Open", IN_PROGRESS: "In progress", RESOLVED: "Resolved", CLOSED: "Closed" };

export const TICKET_STATUS_STYLES: Record<TicketStatus, string> = {
  OPEN: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  IN_PROGRESS: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  RESOLVED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  CLOSED: "bg-muted text-muted-foreground",
};

export const TICKET_SUBJECT_MAX = 200;
export const TICKET_DESCRIPTION_MAX = 5000;
export const TICKET_COMMENT_MAX = 2000;

/** Statuses the viewer may move a ticket to. Managers/admins work the ticket; the raiser can only close it or reopen it. */
export function allowedTicketTransitions(role: string | undefined, status: TicketStatus): TicketStatus[] {
  if (role === "MANAGER" || role === "ADMIN") return (["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"] as TicketStatus[]).filter((s) => s !== status);
  if (role === "SALESPERSON") return status === "RESOLVED" || status === "CLOSED" ? ["OPEN", ...(status === "RESOLVED" ? (["CLOSED"] as TicketStatus[]) : [])] : ["CLOSED"];
  return [];
}

export function validateTicketForm(v: { subject: string; description: string }): { subject?: string; description?: string } {
  const errors: { subject?: string; description?: string } = {};
  if (v.subject.trim().length < 3) errors.subject = "Add a short subject.";
  if (v.description.trim().length < 10) errors.description = "Describe the problem in a few words.";
  return errors;
}
