import { useMutation, useQueryClient } from "@tanstack/react-query";
import { whatsappConversationApi } from "../endpoints/whatsapp-conversation.api";
import { whatsappConversationKeys } from "../queries/whatsapp-conversation.queries";
import { whatsappHistoryKeys } from "../queries/whatsapp-history.queries";
import type { ConversationDetail } from "../types/whatsapp-conversation.types";

function useConversationAction<TVariables = void>(fn: (leadId: string, variables: TVariables) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation<unknown, unknown, { leadId: string; variables: TVariables }>({
    mutationFn: ({ leadId, variables }) => fn(leadId, variables),
    onSuccess: (_data, { leadId }) => {
      queryClient.invalidateQueries({ queryKey: whatsappConversationKeys.detail(leadId) });
      queryClient.invalidateQueries({ queryKey: whatsappHistoryKeys.all });
    },
  });
}

export function useMarkConversationReadMutation() {
  return useConversationAction<void>((leadId) => whatsappConversationApi.markRead(leadId));
}

export function useAssignConversationMutation() {
  return useConversationAction<{ userId: string }>((leadId, { userId }) => whatsappConversationApi.assign(leadId, userId));
}

export function useHandoffConversationMutation() {
  return useConversationAction<void>((leadId) => whatsappConversationApi.handoff(leadId));
}

export function useReturnConversationToAiMutation() {
  return useConversationAction<void>((leadId) => whatsappConversationApi.returnToAi(leadId));
}

export function useSendConversationTextMutation() {
  return useConversationAction<{ text: string }>((leadId, { text }) => whatsappConversationApi.sendText(leadId, text));
}

export function useConfirmOrderDraftMutation() {
  const queryClient = useQueryClient();
  return useMutation<{ orderId: string }, unknown, { leadId: string }>({
    mutationFn: ({ leadId }) => whatsappConversationApi.confirmOrderDraft(leadId),
    onSuccess: (_data, { leadId }) => {
      queryClient.invalidateQueries({ queryKey: whatsappConversationKeys.detail(leadId) });
      queryClient.invalidateQueries({ queryKey: whatsappConversationKeys.draft(leadId) });
      queryClient.invalidateQueries({ queryKey: whatsappHistoryKeys.all });
    },
  });
}

export type { ConversationDetail };
