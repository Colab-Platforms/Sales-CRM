import { useMutation, useQueryClient } from "@tanstack/react-query";
import { leadApi } from "../endpoints/lead.api";
import { leadKeys } from "../queries/lead.queries";
import type {
  BulkAssignManagerPayload,
  BulkAssignSalespersonPayload,
  CreateLeadPayload,
  Lead,
  UpdateLeadPayload,
} from "../types/lead.types";

export function useCreateLeadMutation() {
  const queryClient = useQueryClient();

  return useMutation<Lead, unknown, CreateLeadPayload>({
    mutationFn: (payload) => leadApi.createLead(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}

export function useUpdateLeadMutation() {
  const queryClient = useQueryClient();

  return useMutation<Lead, unknown, { id: string; payload: UpdateLeadPayload }>({
    mutationFn: ({ id, payload }) => leadApi.updateLead(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}

export function useBulkAssignManagerMutation() {
  const queryClient = useQueryClient();

  return useMutation<{ assignedCount: number }, unknown, BulkAssignManagerPayload>({
    mutationFn: (payload) => leadApi.bulkAssignManager(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}

export function useBulkAssignSalespersonMutation() {
  const queryClient = useQueryClient();

  return useMutation<{ assignedCount: number }, unknown, BulkAssignSalespersonPayload>({
    mutationFn: (payload) => leadApi.bulkAssignSalesperson(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}

export function usePreviewImportMutation() {
  return useMutation<
    Awaited<ReturnType<typeof leadApi.previewImport>>,
    unknown,
    { file: File; columnMapping: Record<string, string> }
  >({
    mutationFn: ({ file, columnMapping }) => leadApi.previewImport(file, columnMapping),
  });
}

export function useConfirmImportMutation() {
  const queryClient = useQueryClient();

  return useMutation<Awaited<ReturnType<typeof leadApi.confirmImport>>, unknown, string>({
    mutationFn: (batchId) => leadApi.confirmImport(batchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}
