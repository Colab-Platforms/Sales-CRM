import axios from "axios";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { customersApi } from "../endpoints/customers.api";
import type { CustomerTimelineParams, CustomersListParams } from "../types/customers.types";

export const customersKeys = {
  all: ["customers"] as const,
  list: (params: CustomersListParams) => [...customersKeys.all, "list", params] as const,
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
