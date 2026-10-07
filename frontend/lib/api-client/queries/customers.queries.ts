import axios from "axios";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { customersApi } from "../endpoints/customers.api";
import type { CustomerTimelineParams, CustomersListParams, LiveCustomersListParams } from "../types/customers.types";

export const customersKeys = {
  all: ["customers"] as const,
  list: (params: CustomersListParams) => [...customersKeys.all, "list", params] as const,
  liveLists: () => [...customersKeys.all, "live-list"] as const,
  liveList: (params: LiveCustomersListParams) => [...customersKeys.liveLists(), params] as const,
  detail: (leadId: string) => [...customersKeys.all, "detail", leadId] as const,
  timeline: (leadId: string, params: CustomerTimelineParams) =>
    [...customersKeys.all, "timeline", leadId, params] as const,
};

const STALE_TIME_MS = 30 * 1000;
const MAX_RETRIES = 2;

// A 4xx (bad id, not found, forbidden) will not fix itself, so show the error at once
// instead of waiting through retries. Network and 5xx errors still retry.
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (axios.isAxiosError(error) && error.response && error.response.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

export function customersListQueryOptions(params: CustomersListParams) {
  return queryOptions({
    queryKey: customersKeys.list(params),
    queryFn: () => customersApi.list(params),
    staleTime: STALE_TIME_MS,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

// Shorter staleTime than the DB-backed list: this reads live from Shopify, and the backend already
// has its own 30s cache in front of the real Shopify call (customers.live.service.ts).
const LIVE_LIST_STALE_TIME_MS = 20 * 1000;

export function customersLiveListQueryOptions(params: LiveCustomersListParams) {
  return queryOptions({
    queryKey: customersKeys.liveList(params),
    queryFn: () => customersApi.listLive(params),
    staleTime: LIVE_LIST_STALE_TIME_MS,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

export function customer360QueryOptions(leadId: string) {
  return queryOptions({
    queryKey: customersKeys.detail(leadId),
    queryFn: () => customersApi.get(leadId),
    staleTime: STALE_TIME_MS,
    retry: retryUnlessClientError,
  });
}

export function customerTimelineQueryOptions(leadId: string, params: CustomerTimelineParams) {
  return queryOptions({
    queryKey: customersKeys.timeline(leadId, params),
    queryFn: () => customersApi.getTimeline(leadId, params),
    staleTime: STALE_TIME_MS,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

// Fetched only when the Delete Customer confirmation dialog actually opens - never eagerly, since it's
// ADMIN/MANAGER-only and irrelevant otherwise.
export function customerDeactivationImpactQueryOptions(leadId: string) {
  return queryOptions({
    queryKey: [...customersKeys.detail(leadId), "deactivation-impact"] as const,
    queryFn: () => customersApi.getDeactivationImpact(leadId),
    retry: retryUnlessClientError,
  });
}
