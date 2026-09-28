import { useMutation, useQueryClient } from "@tanstack/react-query";
import { abandonmentApi } from "../endpoints/abandonment.api";
import { abandonmentKeys } from "../queries/abandonment.queries";
import type { CreateRecoveryActionInput } from "../types/abandonment.types";

export function useLogRecoveryActionMutation(abandonmentId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, CreateRecoveryActionInput>({
    mutationFn: (input) => abandonmentApi.logRecoveryAction(abandonmentId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: abandonmentKeys.detail(abandonmentId) });
      queryClient.invalidateQueries({ queryKey: abandonmentKeys.lists() });
    },
  });
}
