import { queryOptions } from "@tanstack/react-query";
import { callHistoryApi } from "../endpoints/call-history.api";
import type { CallListParams } from "../types/call-history.types";

export const callHistoryKeys = {
  all: ["call-history"] as const,
  list: (params: CallListParams) => [...callHistoryKeys.all, "list", params] as const,
  detail: (callId: string) => [...callHistoryKeys.all, "detail", callId] as const,
};

export function callHistoryListQueryOptions(params: CallListParams) {
  return queryOptions({
    queryKey: callHistoryKeys.list(params),
    queryFn: () => callHistoryApi.list(params),
  });
}

export function callHistoryDetailQueryOptions(callId: string) {
  return queryOptions({
    queryKey: callHistoryKeys.detail(callId),
    queryFn: () => callHistoryApi.get(callId),
  });
}
