import { useMutation, useQueryClient } from "@tanstack/react-query";
import { callingApi } from "../endpoints/calling.api";
import { callingKeys } from "../queries/calling.queries";
import { leadKeys } from "../queries/lead.queries";
import type {
  Call,
  SubmitCallOutcomePayload,
  VirtualNumberRecord,
  CreateVirtualNumberPayload,
  UpdateVirtualNumberPayload,
} from "../types/calling.types";

export function useSubmitCallOutcomeMutation(leadId: string) {
  const queryClient = useQueryClient();

  return useMutation<Call, unknown, { callId: string; payload: SubmitCallOutcomePayload }>({
    mutationFn: ({ callId, payload }) => callingApi.submitCallOutcome(callId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: callingKeys.leadCalls(leadId) });
      // The outcome can change the lead's status, which the leads list/detail also show.
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}

function invalidateVirtualNumbers(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: callingKeys.allVirtualNumbers() });
  queryClient.invalidateQueries({ queryKey: callingKeys.virtualNumbers() });
}

export function useCreateVirtualNumberMutation() {
  const queryClient = useQueryClient();

  return useMutation<VirtualNumberRecord, unknown, CreateVirtualNumberPayload>({
    mutationFn: (payload) => callingApi.createVirtualNumber(payload),
    onSuccess: () => invalidateVirtualNumbers(queryClient),
  });
}

export function useUpdateVirtualNumberMutation() {
  const queryClient = useQueryClient();

  return useMutation<VirtualNumberRecord, unknown, { id: string; payload: UpdateVirtualNumberPayload }>({
    mutationFn: ({ id, payload }) => callingApi.updateVirtualNumber(id, payload),
    onSuccess: () => invalidateVirtualNumbers(queryClient),
  });
}

export function useDeleteVirtualNumberMutation() {
  const queryClient = useQueryClient();

  return useMutation<void, unknown, string>({
    mutationFn: (id) => callingApi.deleteVirtualNumber(id),
    onSuccess: () => invalidateVirtualNumbers(queryClient),
  });
}
