"use client";

import { useQuery } from "@tanstack/react-query";
import { dashboardQueryOptions } from "@/lib/api-client/queries/dashboard.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";

export function useDashboard() {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...dashboardQueryOptions(),
    enabled: Boolean(token),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending,
    error: query.error ? getErrorMessage(query.error, "Failed to load dashboard.") : null,
  };
}
