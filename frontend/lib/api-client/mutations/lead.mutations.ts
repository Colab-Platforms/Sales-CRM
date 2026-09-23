import { useMutation, useQueryClient } from "@tanstack/react-query";
import { leadApi } from "../endpoints/lead.api";
import { leadKeys } from "../queries/lead.queries";
import { customersKeys } from "../queries/customers.queries";
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

export function useDeleteLeadMutation() {
  const queryClient = useQueryClient();

  return useMutation<{ id: string }, unknown, string>({
    mutationFn: (id) => leadApi.deleteLead(id),
    onSuccess: (_result, id) => {
      // Lead Detail is the Customer 360 page - same underlying record, so both caches drop it.
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
      queryClient.invalidateQueries({ queryKey: customersKeys.all });
      queryClient.removeQueries({ queryKey: customersKeys.detail(id) });
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
