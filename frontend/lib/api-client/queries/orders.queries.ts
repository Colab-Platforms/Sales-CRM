import axios from "axios";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { ordersApi } from "../endpoints/orders.api";
import type { LiveOrderHistoryParams, LiveOrdersListParams, OrdersListParams } from "../types/orders.types";

export const ordersKeys = {
  all: ["orders"] as const,
  lists: () => [...ordersKeys.all, "list"] as const,
  list: (params: OrdersListParams) => [...ordersKeys.lists(), params] as const,
  liveLists: () => [...ordersKeys.all, "live-list"] as const,
  liveList: (params: LiveOrdersListParams) => [...ordersKeys.liveLists(), params] as const,
  detail: (id: string) => [...ordersKeys.all, "detail", id] as const,
  liveDetail: (externalId: string) => [...ordersKeys.all, "live-detail", externalId] as const,
  liveHistory: (shopifyCustomerId: string, params: LiveOrderHistoryParams) => [...ordersKeys.all, "live-history", shopifyCustomerId, params] as const,
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

// Shorter staleTime than the DB-backed list: this reads live from Shopify, and the backend already
// has its own 30s cache in front of the real Shopify call (orders.live.service.ts) - this just avoids
// React Query re-firing the request on every remount within that same window.
const LIVE_LIST_STALE_TIME_MS = 20 * 1000;

export function ordersLiveListQueryOptions(params: LiveOrdersListParams) {
  return queryOptions({
    queryKey: ordersKeys.liveList(params),
    queryFn: () => ordersApi.listLive(params),
    staleTime: LIVE_LIST_STALE_TIME_MS,
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

export function orderLiveDetailQueryOptions(externalId: string) {
  return queryOptions({
    queryKey: ordersKeys.liveDetail(externalId),
    queryFn: () => ordersApi.getLiveDetail(externalId),
    staleTime: LIST_STALE_TIME_MS,
    retry: retryUnlessClientError,
  });
}

export function orderLiveHistoryQueryOptions(shopifyCustomerId: string, params: LiveOrderHistoryParams) {
  return queryOptions({
    queryKey: ordersKeys.liveHistory(shopifyCustomerId, params),
    queryFn: () => ordersApi.getLiveHistory(shopifyCustomerId, params),
    staleTime: LIVE_LIST_STALE_TIME_MS,
    placeholderData: keepPreviousData,
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
