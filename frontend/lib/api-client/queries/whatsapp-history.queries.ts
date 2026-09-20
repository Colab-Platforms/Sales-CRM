import axios from "axios";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { whatsappHistoryApi } from "../endpoints/whatsapp-history.api";
import type { ListMessagesParams } from "../types/whatsapp-history.types";

export const whatsappHistoryKeys = {
  all: ["whatsapp-messages"] as const,
  list: (params: ListMessagesParams) => [...whatsappHistoryKeys.all, "list", params] as const,
  detail: (id: string) => [...whatsappHistoryKeys.all, "detail", id] as const,
};

const STALE_TIME_MS = 30 * 1000;
const MAX_RETRIES = 2;

function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (axios.isAxiosError(error) && error.response && error.response.status < 500) return false;
  return failureCount < MAX_RETRIES;
}

export function whatsappMessageListQueryOptions(params: ListMessagesParams) {
  return queryOptions({
    queryKey: whatsappHistoryKeys.list(params),
    queryFn: () => whatsappHistoryApi.list(params),
    staleTime: STALE_TIME_MS,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

export function whatsappMessageDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: whatsappHistoryKeys.detail(id),
    queryFn: () => whatsappHistoryApi.get(id),
    staleTime: STALE_TIME_MS,
    retry: retryUnlessClientError,
  });
}
