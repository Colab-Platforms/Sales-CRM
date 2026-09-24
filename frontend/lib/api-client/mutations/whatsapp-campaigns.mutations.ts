import { useMutation, useQueryClient } from "@tanstack/react-query";
import { whatsappCampaignsApi } from "../endpoints/whatsapp-campaigns.api";
import { whatsappCampaignKeys } from "../queries/whatsapp-campaigns.queries";
import type { AudienceFilters, AudiencePreview, CampaignDetail, CreateCampaignInput, LaunchCampaignInput, UpdateCampaignInput } from "../types/whatsapp-campaigns.types";

export function usePreviewAudienceMutation() {
  return useMutation<AudiencePreview, unknown, AudienceFilters>({
    mutationFn: (filters) => whatsappCampaignsApi.previewAudience(filters),
  });
}

export function useCreateCampaignMutation() {
  const queryClient = useQueryClient();
  return useMutation<CampaignDetail, unknown, CreateCampaignInput>({
    mutationFn: (input) => whatsappCampaignsApi.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: whatsappCampaignKeys.all }),
  });
}

export function useUpdateCampaignMutation() {
  const queryClient = useQueryClient();
  return useMutation<CampaignDetail, unknown, { id: string; input: UpdateCampaignInput }>({
    mutationFn: ({ id, input }) => whatsappCampaignsApi.update(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: whatsappCampaignKeys.all }),
  });
}

export function useLaunchCampaignMutation() {
  const queryClient = useQueryClient();
  return useMutation<CampaignDetail, unknown, { id: string; input: LaunchCampaignInput }>({
    mutationFn: ({ id, input }) => whatsappCampaignsApi.launch(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: whatsappCampaignKeys.all }),
  });
}

export function useCancelCampaignMutation() {
  const queryClient = useQueryClient();
  return useMutation<CampaignDetail, unknown, string>({
    mutationFn: (id) => whatsappCampaignsApi.cancel(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: whatsappCampaignKeys.all }),
  });
}
