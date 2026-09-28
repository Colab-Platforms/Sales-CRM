import { useMutation, useQueryClient } from "@tanstack/react-query";
import { abandonmentApi } from "../endpoints/abandonment.api";
import { abandonmentKeys } from "../queries/abandonment.queries";
import type { BulkAssignManagerPayload, BulkAssignSalespersonPayload, CreateRecoveryActionInput } from "../types/abandonment.types";

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
