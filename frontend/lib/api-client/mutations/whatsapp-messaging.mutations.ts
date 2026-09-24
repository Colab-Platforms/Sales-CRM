import { useMutation, useQueryClient } from "@tanstack/react-query";
import { whatsappMessagingApi } from "../endpoints/whatsapp-messaging.api";
import { customersKeys } from "../queries/customers.queries";
import { whatsappHistoryKeys } from "../queries/whatsapp-history.queries";
import { whatsappKeys } from "../queries/whatsapp.queries";
import type { PreviewTemplateInput, SendTemplateInput, TemplatePreviewResult, WhatsAppMessageResult } from "../types/whatsapp-messaging.types";

export function usePreviewTemplateMutation() {
  return useMutation<TemplatePreviewResult, unknown, PreviewTemplateInput>({
    mutationFn: (input) => whatsappMessagingApi.preview(input),
  });
}

export function useSendTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation<WhatsAppMessageResult, unknown, SendTemplateInput>({
    mutationFn: (input) => whatsappMessagingApi.send(input),
    onSuccess: (_, variables) => {
      // The customer's timeline and 360 profile (and, for an admin/manager, integration status) both just changed.
      queryClient.invalidateQueries({ queryKey: [...customersKeys.all, "timeline", variables.leadId] });
      queryClient.invalidateQueries({ queryKey: customersKeys.detail(variables.leadId) });
      queryClient.invalidateQueries({ queryKey: whatsappKeys.all });
      queryClient.invalidateQueries({ queryKey: whatsappHistoryKeys.all });
    },
  });
}
