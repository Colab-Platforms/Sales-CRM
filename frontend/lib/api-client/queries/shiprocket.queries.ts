import axios from "axios";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { shiprocketApi } from "../endpoints/shiprocket.api";
import type { ListShipmentsParams } from "../types/shiprocket.types";

export const shiprocketKeys = {
  all: ["shiprocket-shipments"] as const,
  lists: () => [...shiprocketKeys.all, "list"] as const,
  list: (params: ListShipmentsParams) => [...shiprocketKeys.lists(), params] as const,
  detail: (id: string) => [...shiprocketKeys.all, "detail", id] as const,
  filterOptions: () => [...shiprocketKeys.all, "filter-options"] as const,
};

const LIST_STALE_TIME_MS = 30 * 1000;
const MAX_RETRIES = 2;

// A 4xx (bad id, not found, forbidden) will not fix itself, so show it at once instead of waiting through retries.
// Network and 5xx errors still retry - same convention as orders.queries.ts.
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (axios.isAxiosError(error) && error.response && error.response.status < 500) return false;
  return failureCount < MAX_RETRIES;
}

export function shiprocketListQueryOptions(params: ListShipmentsParams) {
  return queryOptions({
    queryKey: shiprocketKeys.list(params),
    queryFn: () => shiprocketApi.list(params),
    staleTime: LIST_STALE_TIME_MS,
    // Keep the current rows on screen while the next page/filter loads.
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

export function shiprocketDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: shiprocketKeys.detail(id),
    queryFn: () => shiprocketApi.get(id),
    staleTime: LIST_STALE_TIME_MS,
    retry: retryUnlessClientError,
  });
}

export function shiprocketFilterOptionsQueryOptions() {
  return queryOptions({
    queryKey: shiprocketKeys.filterOptions(),
    queryFn: shiprocketApi.getFilterOptions,
    retry: retryUnlessClientError,
  });
}
