import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { abandonmentApi } from "../endpoints/abandonment.api";
import type { ListAbandonmentsParams } from "../types/abandonment.types";

export const abandonmentKeys = {
  all: ["abandonments"] as const,
  lists: () => [...abandonmentKeys.all, "list"] as const,
  list: (params: ListAbandonmentsParams) => [...abandonmentKeys.lists(), params] as const,
  detail: (id: string) => [...abandonmentKeys.all, "detail", id] as const,
};

const LIST_STALE_TIME_MS = 30 * 1000;

export function abandonmentListQueryOptions(params: ListAbandonmentsParams) {
  return queryOptions({
    queryKey: abandonmentKeys.list(params),
    queryFn: () => abandonmentApi.list(params),
    staleTime: LIST_STALE_TIME_MS,
    // Keep the current rows on screen while the next page/filter loads.
    placeholderData: keepPreviousData,
  });
}

export function abandonmentDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: abandonmentKeys.detail(id),
    queryFn: () => abandonmentApi.get(id),
    staleTime: LIST_STALE_TIME_MS,
  });
}
