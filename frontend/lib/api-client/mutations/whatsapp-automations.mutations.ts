import { useMutation, useQueryClient } from "@tanstack/react-query";
import { whatsappAutomationsApi } from "../endpoints/whatsapp-automations.api";
import { whatsappAutomationKeys } from "../queries/whatsapp-automations.queries";
import type { AutomationConfig, UpdateAutomationConfigInput, WhatsAppAutomationType } from "../types/whatsapp-automations.types";

export function useUpdateAutomationConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation<AutomationConfig, unknown, { automationType: WhatsAppAutomationType; input: UpdateAutomationConfigInput }>({
    mutationFn: ({ automationType, input }) => whatsappAutomationsApi.update(automationType, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: whatsappAutomationKeys.all });
    },
  });
}
