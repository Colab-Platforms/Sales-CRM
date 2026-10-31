import { useMutation, useQueryClient } from "@tanstack/react-query";
import { abandonmentApi } from "../endpoints/abandonment.api";
import { abandonmentKeys } from "../queries/abandonment.queries";
import type { IngestionReconcileResult } from "../types/abandonment.types";
import type { AutoAssignConfig, BulkAssignManagerPayload, BulkAssignSalespersonPayload, BulkUpdateLeadStatusPayload, CreateRecoveryActionInput, ManagerAutoAssignConfig, RedistributeAbsentResult } from "../types/abandonment.types";

export function useLogRecoveryActionMutation(abandonmentId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, CreateRecoveryActionInput>({
    mutationFn: (input) => abandonmentApi.logRecoveryAction(abandonmentId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: abandonmentKeys.all });
    },
  });
}

export function useBulkAssignManagerMutation() {
  const queryClient = useQueryClient();
  return useMutation<{ assignedCount: number }, unknown, BulkAssignManagerPayload>({
    mutationFn: (payload) => abandonmentApi.bulkAssignManager(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: abandonmentKeys.all });
    },
  });
}

export function useBulkAssignSalespersonMutation() {
  const queryClient = useQueryClient();
  return useMutation<{ assignedCount: number; unchangedCount?: number }, unknown, BulkAssignSalespersonPayload>({
    mutationFn: (payload) => abandonmentApi.bulkAssignSalesperson(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: abandonmentKeys.all });
    },
  });
}

export function useBulkUpdateLeadStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation<{ updatedCount: number }, unknown, BulkUpdateLeadStatusPayload>({
    mutationFn: (payload) => abandonmentApi.bulkUpdateLeadStatus(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: abandonmentKeys.all });
    },
  });
}

export function usePreviewAbandonmentImportMutation() {
  return useMutation<Awaited<ReturnType<typeof abandonmentApi.previewImport>>, unknown, { file: File; columnMapping: Record<string, string> }>({
    mutationFn: ({ file, columnMapping }) => abandonmentApi.previewImport(file, columnMapping),
  });
}

export function useConfirmAbandonmentImportMutation() {
  const queryClient = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof abandonmentApi.confirmImport>>, unknown, string>({
    mutationFn: (batchId) => abandonmentApi.confirmImport(batchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: abandonmentKeys.all });
    },
  });
}

export function useSetManagerAutoAssignMutation() {
  const queryClient = useQueryClient();
  return useMutation<ManagerAutoAssignConfig, unknown, { enabled: boolean; managerIds?: string[] }>({
    mutationFn: ({ enabled, managerIds }) => abandonmentApi.setManagerAutoAssignConfig(enabled, managerIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: abandonmentKeys.managerAutoAssignConfig() });
    },
  });
}

export function useSetSalespersonAutoAssignMutation() {
  const queryClient = useQueryClient();
  return useMutation<AutoAssignConfig, unknown, boolean>({
    mutationFn: (enabled) => abandonmentApi.setSalespersonAutoAssignConfig(enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: abandonmentKeys.salespersonAutoAssignConfig() });
    },
  });
}

export function useRedistributeAbsentMutation() {
  const queryClient = useQueryClient();
  return useMutation<RedistributeAbsentResult, unknown, boolean>({
    mutationFn: (confirm) => abandonmentApi.redistributeAbsent(confirm),
    onSuccess: (result) => {
      // only a confirmed run changes who owns what
      if (result.confirmed) queryClient.invalidateQueries({ queryKey: abandonmentKeys.all });
    },
  });
}

export function useReconcileIngestionMutation() {
  const queryClient = useQueryClient();
  return useMutation<IngestionReconcileResult, unknown, Record<string, never>>({
    mutationFn: () => abandonmentApi.reconcileIngestion(),
    onSuccess: () => {
      // the recovered leads appear in the lists, the distribution and the health numbers
      queryClient.invalidateQueries({ queryKey: abandonmentKeys.all });
    },
  });
}

