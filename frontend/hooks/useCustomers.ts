"use client";

import { useQuery } from "@tanstack/react-query";
import { customer360QueryOptions, customerTimelineQueryOptions } from "@/lib/api-client/queries/customers.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";
import type { CustomerTimelineParams } from "@/lib/api-client/types/customers.types";

export function useCustomer360(leadId: string) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...customer360QueryOptions(leadId),
    enabled: Boolean(token) && Boolean(leadId),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending,
    error: query.error ? getErrorMessage(query.error, "Failed to load customer.") : null,
    refetch: query.refetch,
  };
}

export function useCustomerTimeline(leadId: string, params: CustomerTimelineParams) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...customerTimelineQueryOptions(leadId, params),
    enabled: Boolean(token) && Boolean(leadId),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending && query.fetchStatus !== "idle",
    isFetching: query.isFetching,
    error: query.error ? getErrorMessage(query.error, "Failed to load timeline.") : null,
  };
}
