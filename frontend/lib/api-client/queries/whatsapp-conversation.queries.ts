import { queryOptions } from "@tanstack/react-query";
import { whatsappConversationApi } from "../endpoints/whatsapp-conversation.api";

export const whatsappConversationKeys = {
  all: ["whatsapp-conversation"] as const,
  detail: (leadId: string) => [...whatsappConversationKeys.all, "detail", leadId] as const,
  capability: (leadId: string) => [...whatsappConversationKeys.all, "capability", leadId] as const,
  draft: (leadId: string) => [...whatsappConversationKeys.all, "draft", leadId] as const,
};

export function conversationDetailQueryOptions(leadId: string) {
  return queryOptions({
    queryKey: whatsappConversationKeys.detail(leadId),
    queryFn: () => whatsappConversationApi.getDetail(leadId),
    // Polling is the only "live" mechanism this app has (no websocket/SSE infra) - just enough to
    // surface an AI reply/handoff that happened while this pane was open but idle.
    refetchInterval: 15_000,
  });
}

export function orderDraftQueryOptions(leadId: string) {
  return queryOptions({
    queryKey: whatsappConversationKeys.draft(leadId),
    queryFn: () => whatsappConversationApi.getOrderDraft(leadId),
    refetchInterval: 15_000,
  });
}

export function messagingCapabilityQueryOptions(leadId: string) {
  return queryOptions({
    queryKey: whatsappConversationKeys.capability(leadId),
    queryFn: () => whatsappConversationApi.getCapability(leadId),
    // A new Meta inbound flips the provider / reopens the 24-hour window while the pane is open; same cadence as the detail query.
    refetchInterval: 15_000,
  });
}
