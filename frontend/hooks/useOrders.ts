"use client";

import { useQuery } from "@tanstack/react-query";
import {
  orderDetailQueryOptions,
  orderFilterOptionsQueryOptions,
  orderStatusHistoryQueryOptions,
  ordersListQueryOptions,
} from "@/lib/api-client/queries/orders.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";
import type { OrdersListParams } from "@/lib/api-client/types/orders.types";

export function useOrders(params: OrdersListParams, options: { enabled?: boolean } = {}) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...ordersListQueryOptions(params),
    enabled: Boolean(token) && (options.enabled ?? true),
  });

  return {
    data: query.data ?? null,
    // True only until the first result arrives; later page/filter changes keep the old rows.
    isLoading: query.isPending && query.fetchStatus !== "idle",
    isFetching: query.isFetching,
    error: query.error ? getErrorMessage(query.error, "Failed to load orders.") : null,
    refetch: query.refetch,
  };
}

export function useOrder(id: string) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...orderDetailQueryOptions(id),
    enabled: Boolean(token),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending,
    error: query.error ? getErrorMessage(query.error, "Failed to load order.") : null,
    refetch: query.refetch,
  };
}

export function useOrderStatusHistory(id: string) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...orderStatusHistoryQueryOptions(id),
    enabled: Boolean(token),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending,
    error: query.error ? getErrorMessage(query.error, "Failed to load status history.") : null,
  };
}

export function useOrderFilterOptions(enabled = true) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...orderFilterOptionsQueryOptions(),
    enabled: Boolean(token) && enabled,
  });

  return { salespeople: query.data?.salespeople ?? [] };
}
