import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "../endpoints/admin.api";
import { adminKeys } from "../queries/admin.queries";
import type { CreateManagerPayload, ManagerUser, UpdateManagerPayload } from "../types/admin.types";

export function useCreateManagerMutation() {
  const queryClient = useQueryClient();

  return useMutation<ManagerUser, unknown, CreateManagerPayload>({
    mutationFn: (payload) => adminApi.createManager(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.managers() });
    },
  });
}

export function useUpdateManagerMutation() {
  const queryClient = useQueryClient();

  return useMutation<ManagerUser, unknown, { id: string; payload: UpdateManagerPayload }>({
    mutationFn: ({ id, payload }) => adminApi.updateManager(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.managers() });
    },
  });
}

export function useDeactivateManagerMutation() {
  const queryClient = useQueryClient();

  return useMutation<ManagerUser, unknown, string>({
    mutationFn: (id) => adminApi.deactivateManager(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.managers() });
    },
  });
}
