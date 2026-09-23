import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sourceApi } from "../endpoints/source.api";
import { sourceKeys } from "../queries/source.queries";
import type { CreateSourcePayload, Source, UpdateSourcePayload } from "../types/source.types";

export function useCreateSourceMutation() {
  const queryClient = useQueryClient();

  return useMutation<Source, unknown, CreateSourcePayload>({
    mutationFn: (payload) => sourceApi.createSource(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sourceKeys.list() });
    },
  });
}

export function useUpdateSourceMutation() {
  const queryClient = useQueryClient();

  return useMutation<Source, unknown, { id: string; payload: UpdateSourcePayload }>({
    mutationFn: ({ id, payload }) => sourceApi.updateSource(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sourceKeys.list() });
    },
  });
}

export function useToggleSourceStatusMutation() {
  const queryClient = useQueryClient();

  return useMutation<Source, unknown, { id: string; status: "ACTIVE" | "INACTIVE" }>({
    mutationFn: ({ id, status }) => sourceApi.toggleSourceStatus(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sourceKeys.list() });
    },
  });
}
