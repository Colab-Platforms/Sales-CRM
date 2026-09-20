"use client";

import { useQuery } from "@tanstack/react-query";
import { reconciliationListQueryOptions } from "@/lib/api-client/queries/reconciliation.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";
import type { ReconciliationListParams } from "@/lib/api-client/types/reconciliation.types";

export function useReconciliation(params: ReconciliationListParams, options: { enabled?: boolean } = {}) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...reconciliationListQueryOptions(params),
    enabled: Boolean(token) && (options.enabled ?? true),
  });

  return {
    data: query.data ?? null,
    // True only until the first result arrives; later page/filter changes keep the old rows.
    isLoading: query.isPending && query.fetchStatus !== "idle",
    isFetching: query.isFetching,
    error: query.error ? getErrorMessage(query.error, "Failed to load reconciliation data.") : null,
    refetch: query.refetch,
  };
}
