import { useMutation, useQueryClient } from "@tanstack/react-query";
import { abandonmentApi } from "../endpoints/abandonment.api";
import { abandonmentKeys } from "../queries/abandonment.queries";
import type { AutoAssignConfig, BulkAssignManagerPayload, BulkAssignSalespersonPayload, CreateRecoveryActionInput, ManagerAutoAssignConfig } from "../types/abandonment.types";

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
  return useMutation<{ assignedCount: number }, unknown, BulkAssignSalespersonPayload>({
    mutationFn: (payload) => abandonmentApi.bulkAssignSalesperson(payload),
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
