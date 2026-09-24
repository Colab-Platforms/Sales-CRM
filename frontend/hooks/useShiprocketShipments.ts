"use client";

import { useQuery } from "@tanstack/react-query";
import { shiprocketDetailQueryOptions, shiprocketFilterOptionsQueryOptions, shiprocketListQueryOptions } from "@/lib/api-client/queries/shiprocket.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";
import type { ListShipmentsParams } from "@/lib/api-client/types/shiprocket.types";

export function useShiprocketShipments(params: ListShipmentsParams, options: { enabled?: boolean } = {}) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...shiprocketListQueryOptions(params),
    enabled: Boolean(token) && (options.enabled ?? true),
  });

  return {
    data: query.data ?? null,
    // True only until the first result arrives; later page/filter changes keep the old rows.
    isLoading: query.isPending && query.fetchStatus !== "idle",
    isFetching: query.isFetching,
    error: query.error ? getErrorMessage(query.error, "Failed to load Shiprocket shipments.") : null,
    refetch: query.refetch,
  };
}

export function useShiprocketShipment(id: string | null) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...shiprocketDetailQueryOptions(id ?? ""),
    enabled: Boolean(token) && Boolean(id),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending && query.fetchStatus !== "idle",
    error: query.error ? getErrorMessage(query.error, "Failed to load this shipment.") : null,
  };
}

export function useShiprocketFilterOptions(enabled = true) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...shiprocketFilterOptionsQueryOptions(),
    enabled: Boolean(token) && enabled,
  });

  return { couriers: query.data?.couriers ?? [] };
}
