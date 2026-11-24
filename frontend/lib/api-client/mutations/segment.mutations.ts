import { useMutation, useQueryClient } from "@tanstack/react-query";
import { segmentApi } from "../endpoints/segment.api";
import { segmentKeys } from "../queries/segment.queries";
import { leadKeys } from "../queries/lead.queries";
import type { CreateSegmentPayload, Segment, UpdateSegmentPayload } from "../types/segment.types";

export function useCreateSegmentMutation() {
  const queryClient = useQueryClient();
  return useMutation<Segment, unknown, CreateSegmentPayload>({
    mutationFn: (payload) => segmentApi.create(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: segmentKeys.all }),
  });
}

export function useUpdateSegmentMutation() {
  const queryClient = useQueryClient();
  return useMutation<Segment, unknown, { id: string; payload: UpdateSegmentPayload }>({
    mutationFn: ({ id, payload }) => segmentApi.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: segmentKeys.all });
      // a renamed / recoloured segment changes the tags shown on leads
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}

export function useDeleteSegmentMutation() {
  const queryClient = useQueryClient();
  return useMutation<{ id: string }, unknown, string>({
    mutationFn: (id) => segmentApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: segmentKeys.all }),
  });
}
