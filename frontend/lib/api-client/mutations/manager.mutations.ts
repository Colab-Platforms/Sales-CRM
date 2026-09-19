import { useMutation, useQueryClient } from "@tanstack/react-query";
import { managerApi } from "../endpoints/manager.api";
import { managerKeys } from "../queries/manager.queries";
import type {
  AddExistingMemberPayload,
  AddSalespersonPayload,
  CreateGroupPayload,
  Group,
  SalespersonUser,
  UpdateGroupPayload,
  UpdateSalespersonPayload,
} from "../types/manager.types";

export function useCreateGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation<Group, unknown, CreateGroupPayload>({
    mutationFn: (payload) => managerApi.createGroup(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: managerKeys.groups() });
    },
  });
}

export function useUpdateGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation<Group, unknown, { groupId: string; payload: UpdateGroupPayload }>({
    mutationFn: ({ groupId, payload }) => managerApi.updateGroup(groupId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: managerKeys.groups() });
    },
  });
}

export function useDeleteGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation<Group, unknown, string>({
    mutationFn: (groupId) => managerApi.deleteGroup(groupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: managerKeys.groups() });
    },
  });
}

export function useAddSalespersonMutation() {
  const queryClient = useQueryClient();

  return useMutation<SalespersonUser, unknown, { groupId: string; payload: AddSalespersonPayload }>({
    mutationFn: ({ groupId, payload }) => managerApi.addSalesperson(groupId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: managerKeys.groups() });
    },
  });
}

export function useAddExistingSalespersonMutation() {
  const queryClient = useQueryClient();

  return useMutation<SalespersonUser, unknown, { groupId: string; payload: AddExistingMemberPayload }>({
    mutationFn: ({ groupId, payload }) => managerApi.addExistingSalesperson(groupId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: managerKeys.groups() });
    },
  });
}

export function useUpdateSalespersonMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    SalespersonUser,
    unknown,
    { groupId: string; userId: string; payload: UpdateSalespersonPayload }
  >({
    mutationFn: ({ groupId, userId, payload }) => managerApi.updateSalesperson(groupId, userId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: managerKeys.groups() });
    },
  });
}

export function useRemoveSalespersonMutation() {
  const queryClient = useQueryClient();

  return useMutation<void, unknown, { groupId: string; userId: string }>({
    mutationFn: ({ groupId, userId }) => managerApi.removeSalesperson(groupId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: managerKeys.groups() });
    },
  });
}
