import axios from "axios";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { reconciliationApi } from "../endpoints/reconciliation.api";
import type { ReconciliationListParams } from "../types/reconciliation.types";

export const reconciliationKeys = {
  all: ["reconciliation"] as const,
  list: (params: ReconciliationListParams) => [...reconciliationKeys.all, "list", params] as const,
};

const LIST_STALE_TIME_MS = 30 * 1000;
const MAX_RETRIES = 2;

// A 4xx (bad filter, forbidden) will not fix itself, so show the error at once instead of waiting
// through retries. Network and 5xx errors still retry.
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (axios.isAxiosError(error) && error.response && error.response.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

export function reconciliationListQueryOptions(params: ReconciliationListParams) {
  return queryOptions({
    queryKey: reconciliationKeys.list(params),
    queryFn: () => reconciliationApi.list(params),
    staleTime: LIST_STALE_TIME_MS,
    // Keep the current rows on screen while the next page/filter loads.
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}
