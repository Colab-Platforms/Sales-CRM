import { useMutation, useQueryClient } from "@tanstack/react-query";
import { whatsappCloudConfigApi } from "../endpoints/whatsapp-cloud-config.api";
import { whatsappCloudConfigKeys } from "../queries/whatsapp-cloud-config.queries";
import type { SaveWhatsAppCloudConfigPayload, TestWhatsAppCloudConfigResult, WhatsAppCloudConfig } from "../types/whatsapp-cloud-config.types";

export function useSaveWhatsAppCloudConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation<WhatsAppCloudConfig, unknown, SaveWhatsAppCloudConfigPayload>({
    mutationFn: (payload) => whatsappCloudConfigApi.saveConfig(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: whatsappCloudConfigKeys.all });
    },
  });
}

export function useTestWhatsAppCloudConfigMutation() {
  return useMutation<TestWhatsAppCloudConfigResult, unknown, void>({
    mutationFn: () => whatsappCloudConfigApi.testConnection(),
  });
}

export function useResetWhatsAppCloudConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, void>({
    mutationFn: () => whatsappCloudConfigApi.resetConfig(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: whatsappCloudConfigKeys.all });
    },
  });
}
