import { useMutation, useQueryClient } from "@tanstack/react-query";
import { tasksApi } from "../endpoints/tasks.api";
import { tasksKeys } from "../queries/tasks.queries";
import type { FollowUpTask } from "../types/tasks.types";

export function useCompleteTaskMutation() {
  const queryClient = useQueryClient();

  return useMutation<FollowUpTask, unknown, string>({
    mutationFn: (id) => tasksApi.completeTask(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tasksKeys.all }),
  });
}

export function useSnoozeTaskMutation() {
  const queryClient = useQueryClient();

  return useMutation<FollowUpTask, unknown, { id: string; minutes: number }>({
    mutationFn: ({ id, minutes }) => tasksApi.snoozeTask(id, minutes),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tasksKeys.all }),
  });
}
