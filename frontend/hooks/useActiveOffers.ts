"use client";

import { useQuery } from "@tanstack/react-query";
import { offersApi } from "@/lib/api-client/endpoints/offers.api";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";

export const offersKeys = { active: ["offers", "active"] as const };

// The backend caches Fastrr for ~2 minutes, so a minute of client freshness is plenty; reusable by any screen that
// later needs the current offers (order flow, WhatsApp...).
export function useActiveOffers() {
  const token = useAuthStore((s) => s.token);
  const query = useQuery({ queryKey: offersKeys.active, queryFn: () => offersApi.active(), enabled: Boolean(token), staleTime: 60_000, retry: 1 });
  return {
    data: query.data,
    isLoading: query.isPending && query.fetchStatus !== "idle",
    isFetching: query.isFetching,
    error: query.isError ? getErrorMessage(query.error, "Unable to load active offers from Fastrr.") : null,
    refetch: query.refetch,
  };
}
