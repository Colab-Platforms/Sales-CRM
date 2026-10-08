import type { WebChatConversationListItem, WebChatListParams } from "@/lib/api-client/types/webchat.types";

const PAGE_SIZE = 25;
// "Assigned to me" has no backend filter, so it narrows a larger fetched page on the client.
const MINE_PAGE_SIZE = 100;

/** The queue views. Each maps onto filters the backend already supports - nothing invented.
 * "all"/"waitingForHuman"/"aiActive" are the primary, customer-support-inbox tabs: the default
 * (all) omits `mode` entirely so both AI and HUMAN conversations show, matching every other active
 * (non-archived) conversation. Unassigned/assigned/mine stay scoped to HUMAN - an AI conversation
 * has no agent to assign, so those three only make sense once it's waiting for a human. */
export type WebChatQueueFilter = "all" | "waitingForHuman" | "aiActive" | "unassigned" | "assigned" | "mine" | "archived";

export const FILTER_LABELS: Record<WebChatQueueFilter, string> = {
  all: "All",
  waitingForHuman: "Waiting for Human",
  aiActive: "AI Active",
  unassigned: "Unassigned",
  assigned: "Assigned",
  mine: "Assigned to me",
  archived: "Archived",
};

/** The three primary tabs shown as pills above the finer-grained select. */
export const PRIMARY_FILTERS: WebChatQueueFilter[] = ["all", "waitingForHuman", "aiActive"];

export function filterToParams(filter: WebChatQueueFilter, page: number, search: string): WebChatListParams {
  const base: WebChatListParams = { page, limit: filter === "mine" ? MINE_PAGE_SIZE : PAGE_SIZE };
  if (search) base.search = search;
  switch (filter) {
    case "all":
      return { ...base, archived: false };
    case "waitingForHuman":
      return { ...base, mode: "HUMAN", archived: false };
    case "aiActive":
      return { ...base, mode: "AI", archived: false };
    case "unassigned":
      return { ...base, mode: "HUMAN", archived: false, assigned: false };
    case "assigned":
    case "mine":
      return { ...base, mode: "HUMAN", archived: false, assigned: true };
    case "archived":
      return { ...base, archived: true };
  }
}

/** A chat with no Lead is shown as an anonymous visitor - never an invented customer name. */
export function displayName(conversation: WebChatConversationListItem): string {
  const lead = conversation.lead;
  if (!lead) return "Anonymous Visitor";
  return `${lead.firstName} ${lead.lastName ?? ""}`.trim();
}

/** Unread = a message arrived after the agent last opened the chat (lastReadAt is the existing field). */
export function isUnread(conversation: { lastMessageAt: string | null; lastReadAt: string | null }): boolean {
  if (!conversation.lastMessageAt) return false;
  if (!conversation.lastReadAt) return true;
  return new Date(conversation.lastMessageAt).getTime() > new Date(conversation.lastReadAt).getTime();
}
