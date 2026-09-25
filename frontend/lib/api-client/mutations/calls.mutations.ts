import { useMutation } from "@tanstack/react-query";
import { callsApi } from "../endpoints/calls.api";
import type { InitiateCallResult } from "../types/calls.types";

export function useInitiateCallMutation() {
  return useMutation<InitiateCallResult, unknown, { leadId: string }>({
    mutationFn: ({ leadId }) => callsApi.initiateCall(leadId),
  });
}
