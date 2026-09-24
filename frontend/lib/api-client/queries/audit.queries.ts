import axios from "axios";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { auditApi } from "../endpoints/audit.api";
import type { AuditListParams, EntityAuditParams } from "../types/audit.types";

export const auditKeys = {
  all: ["audit"] as const,
  list: (params: AuditListParams) => [...auditKeys.all, "list", params] as const,
  order: (orderId: string, params: EntityAuditParams) => [...auditKeys.all, "order", orderId, params] as const,
  customer: (leadId: string, params: EntityAuditParams) => [...auditKeys.all, "customer", leadId, params] as const,
};

const STALE_TIME_MS = 30 * 1000;
const MAX_RETRIES = 2;

// A 4xx (bad filter, forbidden, not found) will not fix itself, so show the error at once instead of
// waiting through retries. Network and 5xx errors still retry.
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (axios.isAxiosError(error) && error.response && error.response.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

export function auditListQueryOptions(params: AuditListParams) {
  return queryOptions({
    queryKey: auditKeys.list(params),
    queryFn: () => auditApi.list(params),
    staleTime: STALE_TIME_MS,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

export function orderAuditQueryOptions(orderId: string, params: EntityAuditParams) {
  return queryOptions({
    queryKey: auditKeys.order(orderId, params),
    queryFn: () => auditApi.listForOrder(orderId, params),
    staleTime: STALE_TIME_MS,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

export function customerAuditQueryOptions(leadId: string, params: EntityAuditParams) {
  return queryOptions({
    queryKey: auditKeys.customer(leadId, params),
    queryFn: () => auditApi.listForCustomer(leadId, params),
    staleTime: STALE_TIME_MS,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}
