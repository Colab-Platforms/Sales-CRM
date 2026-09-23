"use client";

import { useQuery } from "@tanstack/react-query";
import { callHistoryDetailQueryOptions, callHistoryListQueryOptions } from "@/lib/api-client/queries/call-history.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";
import type { CallListParams } from "@/lib/api-client/types/call-history.types";

export function useCallHistoryList(params: CallListParams) {
  const token = useAuthStore((s) => s.token);
  const query = useQuery({ ...callHistoryListQueryOptions(params), enabled: Boolean(token), retry: false });

  return {
    data: query.data ?? null,
    isLoading: query.isPending && query.fetchStatus !== "idle",
    isFetching: query.isFetching,
    error: query.error ? getErrorMessage(query.error, "Failed to load call history.") : null,
    refetch: query.refetch,
  };
}

export function useCallHistoryDetail(callId: string) {
  const token = useAuthStore((s) => s.token);
  const query = useQuery({ ...callHistoryDetailQueryOptions(callId), enabled: Boolean(token) && Boolean(callId), retry: false });

  return {
    data: query.data ?? null,
    isLoading: query.isPending && query.fetchStatus !== "idle",
    // A 404 comes back as an ApiError with message "Call not found" (missing or out of the
    // caller's lead scope look identical - see backend call.history.service.ts), so it renders
    // through the same error state as any other failure, with that exact server message.
    error: query.error ? getErrorMessage(query.error, "Failed to load this call.") : null,
    refetch: query.refetch,
  };
}
