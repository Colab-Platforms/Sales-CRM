import { useMutation, useQueryClient } from "@tanstack/react-query";
import { whatsappTemplatesApi } from "../endpoints/whatsapp-templates.api";
import { whatsappTemplateKeys } from "../queries/whatsapp-templates.queries";
import type { CreateTemplateInput, TemplateSyncSummary, UpdateTemplateInput, WhatsAppTemplate } from "../types/whatsapp-templates.types";

export function useCreateTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation<WhatsAppTemplate, unknown, CreateTemplateInput>({
    mutationFn: (input) => whatsappTemplatesApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: whatsappTemplateKeys.all });
    },
  });
}

export function useUpdateTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation<WhatsAppTemplate, unknown, { id: string; input: UpdateTemplateInput }>({
    mutationFn: ({ id, input }) => whatsappTemplatesApi.update(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: whatsappTemplateKeys.all });
    },
  });
}

export function useSyncTemplatesMutation() {
  const queryClient = useQueryClient();
  return useMutation<TemplateSyncSummary, unknown, void>({
    mutationFn: () => whatsappTemplatesApi.sync(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: whatsappTemplateKeys.all });
    },
  });
}
