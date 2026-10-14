import { queryOptions } from "@tanstack/react-query";
import { whatsappConversationApi } from "../endpoints/whatsapp-conversation.api";

export const whatsappConversationKeys = {
  all: ["whatsapp-conversation"] as const,
  detail: (leadId: string) => [...whatsappConversationKeys.all, "detail", leadId] as const,
  capability: (leadId: string) => [...whatsappConversationKeys.all, "capability", leadId] as const,
  draft: (leadId: string) => [...whatsappConversationKeys.all, "draft", leadId] as const,
};

/** The customer behind a conversation (read-only across teams). Keyed by the conversation's lead, so switching conversations never shows the previous customer's data. */
export function conversationCustomerQueryOptions(leadId: string) {
  return queryOptions({
    queryKey: [...whatsappConversationKeys.all, "customer", leadId] as const,
    queryFn: () => whatsappConversationApi.getCustomer(leadId),
    staleTime: 15_000,
    retry: false,
  });
}

export function conversationDetailQueryOptions(leadId: string) {
  return queryOptions({
    queryKey: whatsappConversationKeys.detail(leadId),
    queryFn: () => whatsappConversationApi.getDetail(leadId),
    // Polling is the only "live" mechanism this app has (no websocket/SSE infra) - just enough to
    // surface an AI reply/handoff that happened while this pane was open but idle.
    refetchInterval: 15_000,
    // A lead with no WhatsAppConversation row yet (never messaged on WhatsApp, or predates the
    // conversation model) 404s here by design - a real, stable state, not a transient failure. Without
    // this, React Query's default retry (3 attempts) plus the 15s poll above turned one legitimate 404
    // into a continuous stream of them in the browser console every time this pane was open.
    retry: false,
  });
}

export function orderDraftQueryOptions(leadId: string) {
  return queryOptions({
    queryKey: whatsappConversationKeys.draft(leadId),
    queryFn: () => whatsappConversationApi.getOrderDraft(leadId),
    refetchInterval: 15_000,
    // Same "no conversation row yet" 404 as conversationDetailQueryOptions above (this endpoint reads
    // through the same conversation row) - never retried.
    retry: false,
  });
}

export function messagingCapabilityQueryOptions(leadId: string) {
  return queryOptions({
    queryKey: whatsappConversationKeys.capability(leadId),
    queryFn: () => whatsappConversationApi.getCapability(leadId),
    // A new Meta inbound flips the provider / reopens the 24-hour window while the pane is open; same cadence as the detail query.
    refetchInterval: 15_000,
    // Designed to work even with no conversation row (see the backend's own comment on
    // getMessagingCapability), so a failure here is a real error (out-of-scope lead, etc.), not an
    // expected 404 - but it should still never be blindly retried against a 4xx.
    retry: false,
  });
}
