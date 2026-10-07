"use client";

import { useQuery } from "@tanstack/react-query";
import {
  orderDetailQueryOptions,
  orderFilterOptionsQueryOptions,
  orderTagOptionsQueryOptions,
  orderLiveDetailQueryOptions,
  orderLiveHistoryQueryOptions,
  orderStatusHistoryQueryOptions,
  ordersListQueryOptions,
  ordersLiveListQueryOptions,
} from "@/lib/api-client/queries/orders.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";
import type { LiveOrderHistoryParams, LiveOrdersListParams, OrdersListParams } from "@/lib/api-client/types/orders.types";

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

/** The Orders list page's real data source - live from Shopify, cursor-paginated. `error`/`partialError`
 *  come from inside a successful (HTTP 200) response body, not a thrown error - Shopify being down
 *  or slow is reported cleanly rather than failing the whole request (see orders.live.service.ts). */
export function useLiveOrders(params: LiveOrdersListParams, options: { enabled?: boolean } = {}) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...ordersLiveListQueryOptions(params),
    enabled: Boolean(token) && (options.enabled ?? true),
  });

  return {
    data: query.data ?? null,
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

/** Order Detail for a Shopify order not yet synced into the CRM - see parseLiveOrderId(). */
export function useLiveOrderDetail(externalId: string) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...orderLiveDetailQueryOptions(externalId),
    enabled: Boolean(token) && Boolean(externalId),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending,
    error: query.error ? getErrorMessage(query.error, "Failed to load order.") : null,
    refetch: query.refetch,
  };
}

/** "Previous Orders" on the live Order Detail page - the Shopify customer's other orders, cursor-paginated. */
export function useLiveOrderHistory(shopifyCustomerId: string, params: LiveOrderHistoryParams, options: { enabled?: boolean } = {}) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...orderLiveHistoryQueryOptions(shopifyCustomerId, params),
    enabled: Boolean(token) && Boolean(shopifyCustomerId) && (options.enabled ?? true),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending && query.fetchStatus !== "idle",
    isFetching: query.isFetching,
    error: query.error ? getErrorMessage(query.error, "Failed to load previous orders.") : null,
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

/** The Tags filter's options: tags that exist on real orders (Shopify + the CRM confirmation tags). */
export function useOrderTagOptions(enabled = true) {
  const token = useAuthStore((s) => s.token);
  const query = useQuery({ ...orderTagOptionsQueryOptions(), enabled: Boolean(token) && enabled });
  return {
    tags: query.data?.tags ?? [],
    isLoading: query.isPending && query.fetchStatus !== "idle",
    error: query.error ? "Could not load tags." : (query.data?.error ?? null),
  };
}

export function useOrderFilterOptions(enabled = true) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...orderFilterOptionsQueryOptions(),
    enabled: Boolean(token) && enabled,
  });

  return { salespeople: query.data?.salespeople ?? [], leadSources: query.data?.leadSources ?? [] };
}
