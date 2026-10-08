import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "../endpoints/admin.api";
import { adminKeys } from "../queries/admin.queries";
import type {
  CreateManagerPayload,
  CreateSalespersonPayload,
  ManagerUser,
  ResetPasswordPayload,
  SalespersonUser,
  UpdateManagerPayload,
  UpdateSalespersonPayload,
  HrUser,
  CreateHrPayload,
  Group,
  CreateGroupPayload,
  UpdateGroupPayload,
  AddSalespersonPayload,
  AddExistingMemberPayload,
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

export function useResetManagerPasswordMutation() {
  return useMutation<ManagerUser, unknown, { id: string; payload: ResetPasswordPayload }>({
    mutationFn: ({ id, payload }) => adminApi.resetManagerPassword(id, payload),
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

export function useResetSalespersonPasswordMutation() {
  return useMutation<SalespersonUser, unknown, { id: string; payload: ResetPasswordPayload }>({
    mutationFn: ({ id, payload }) => adminApi.resetSalespersonPassword(id, payload),
  });
}

export function useCreateHrMutation() {
  const queryClient = useQueryClient();

  return useMutation<HrUser, unknown, CreateHrPayload>({
    mutationFn: (payload) => adminApi.createHr(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.hr() });
    },
  });
}

export function useCreateAdminGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation<Group, unknown, CreateGroupPayload>({
    mutationFn: (payload) => adminApi.createGroup(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.groups() });
    },
  });
}

export function useUpdateAdminGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation<Group, unknown, { groupId: string; payload: UpdateGroupPayload }>({
    mutationFn: ({ groupId, payload }) => adminApi.updateGroup(groupId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.groups() });
    },
  });
}

export function useDeleteAdminGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation<Group, unknown, string>({
    mutationFn: (groupId) => adminApi.deleteGroup(groupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.groups() });
    },
  });
}

export function useAddSalespersonToGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation<SalespersonUser, unknown, { groupId: string; payload: AddSalespersonPayload }>({
    mutationFn: ({ groupId, payload }) => adminApi.addSalespersonToGroup(groupId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.groups() });
      queryClient.invalidateQueries({ queryKey: adminKeys.salespersons() });
    },
  });
}

export function useAddExistingSalespersonToGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation<SalespersonUser, unknown, { groupId: string; payload: AddExistingMemberPayload }>({
    mutationFn: ({ groupId, payload }) => adminApi.addExistingSalespersonToGroup(groupId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.groups() });
      queryClient.invalidateQueries({ queryKey: adminKeys.salespersons() });
    },
  });
}

export function useRemoveSalespersonFromGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation<void, unknown, { groupId: string; userId: string }>({
    mutationFn: ({ groupId, userId }) => adminApi.removeSalespersonFromGroup(groupId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.groups() });
      queryClient.invalidateQueries({ queryKey: adminKeys.salespersons() });
    },
  });
}
