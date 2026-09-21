import axios from "axios";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { ordersApi } from "../endpoints/orders.api";
import type { OrdersListParams } from "../types/orders.types";

export const ordersKeys = {
  all: ["orders"] as const,
  lists: () => [...ordersKeys.all, "list"] as const,
  list: (params: OrdersListParams) => [...ordersKeys.lists(), params] as const,
  detail: (id: string) => [...ordersKeys.all, "detail", id] as const,
  statusHistory: (id: string) => [...ordersKeys.all, "status-history", id] as const,
  filterOptions: () => [...ordersKeys.all, "filter-options"] as const,
};

const LIST_STALE_TIME_MS = 30 * 1000;
const MAX_RETRIES = 2;

// A 4xx (bad id, not found, forbidden) will not fix itself, so show the error at once
// instead of waiting through retries. Network and 5xx errors still retry.
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (axios.isAxiosError(error) && error.response && error.response.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

export function ordersListQueryOptions(params: OrdersListParams) {
  return queryOptions({
    queryKey: ordersKeys.list(params),
    queryFn: () => ordersApi.list(params),
    staleTime: LIST_STALE_TIME_MS,
    // Keep the current rows on screen while the next page/filter loads.
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

export function orderDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: ordersKeys.detail(id),
    queryFn: () => ordersApi.get(id),
    staleTime: LIST_STALE_TIME_MS,
    retry: retryUnlessClientError,
  });
}

export function orderStatusHistoryQueryOptions(id: string) {
  return queryOptions({
    queryKey: ordersKeys.statusHistory(id),
    queryFn: () => ordersApi.getStatusHistory(id),
    staleTime: LIST_STALE_TIME_MS,
    retry: retryUnlessClientError,
  });
}

export function orderFilterOptionsQueryOptions() {
  return queryOptions({
    queryKey: ordersKeys.filterOptions(),
    queryFn: ordersApi.getFilterOptions,
    retry: retryUnlessClientError,
  });
}
