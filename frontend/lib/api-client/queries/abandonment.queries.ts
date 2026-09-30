import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { abandonmentApi } from "../endpoints/abandonment.api";
import type { ListAbandonmentsParams } from "../types/abandonment.types";

export const abandonmentKeys = {
  all: ["abandonments"] as const,
  lists: () => [...abandonmentKeys.all, "list"] as const,
  list: (params: ListAbandonmentsParams) => [...abandonmentKeys.lists(), params] as const,
  detail: (id: string) => [...abandonmentKeys.all, "detail", id] as const,
  byLead: (leadId: string) => [...abandonmentKeys.all, "byLead", leadId] as const,
  managerAutoAssignConfig: () => [...abandonmentKeys.all, "autoAssign", "manager"] as const,
  salespersonAutoAssignConfig: () => [...abandonmentKeys.all, "autoAssign", "salesperson"] as const,
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

export function abandonmentByLeadQueryOptions(leadId: string) {
  return queryOptions({
    queryKey: abandonmentKeys.byLead(leadId),
    queryFn: () => abandonmentApi.getByLead(leadId),
    staleTime: LIST_STALE_TIME_MS,
  });
}

export function managerAutoAssignConfigQueryOptions() {
  return queryOptions({
    queryKey: abandonmentKeys.managerAutoAssignConfig(),
    queryFn: () => abandonmentApi.getManagerAutoAssignConfig(),
    staleTime: LIST_STALE_TIME_MS,
  });
}

export function salespersonAutoAssignConfigQueryOptions() {
  return queryOptions({
    queryKey: abandonmentKeys.salespersonAutoAssignConfig(),
    queryFn: () => abandonmentApi.getSalespersonAutoAssignConfig(),
    staleTime: LIST_STALE_TIME_MS,
  });
}
