import axios from "axios";
import { queryOptions } from "@tanstack/react-query";
import { integrationsApi } from "../endpoints/integrations.api";

export const integrationsKeys = {
  all: ["integrations"] as const,
  status: () => [...integrationsKeys.all, "status"] as const,
  couriers: (shipmentId: string) => [...integrationsKeys.all, "couriers", shipmentId] as const,
};

const STATUS_STALE_TIME_MS = 5 * 60 * 1000;

// A 4xx (not configured, not allowed) will not fix itself, so it is shown at once instead of retried.
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (axios.isAxiosError(error) && error.response && error.response.status < 500) return false;
  return failureCount < 2;
}

export function integrationStatusQueryOptions() {
  return queryOptions({
    queryKey: integrationsKeys.status(),
    queryFn: integrationsApi.getStatus,
    staleTime: STATUS_STALE_TIME_MS,
    retry: retryUnlessClientError,
  });
}

// Courier availability and rates change, so this is always fetched fresh for the dialog that shows it.
export function couriersQueryOptions(shipmentId: string) {
  return queryOptions({
    queryKey: integrationsKeys.couriers(shipmentId),
    queryFn: () => integrationsApi.listCouriers(shipmentId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
