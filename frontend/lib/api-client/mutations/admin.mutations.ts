import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "../endpoints/admin.api";
import { adminKeys } from "../queries/admin.queries";
import type {
  CreateManagerPayload,
  CreateSalespersonPayload,
  ManagerUser,
  SalespersonUser,
  UpdateManagerPayload,
  UpdateSalespersonPayload,
} from "../types/admin.types";

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

export function useCreateSalespersonMutation() {
  const queryClient = useQueryClient();

  return useMutation<SalespersonUser, unknown, CreateSalespersonPayload>({
    mutationFn: (payload) => adminApi.createSalesperson(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.salespersons() });
    },
  });
}

export function useUpdateSalespersonMutation() {
  const queryClient = useQueryClient();

  return useMutation<SalespersonUser, unknown, { id: string; payload: UpdateSalespersonPayload }>({
    mutationFn: ({ id, payload }) => adminApi.updateSalesperson(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.salespersons() });
    },
  });
}
