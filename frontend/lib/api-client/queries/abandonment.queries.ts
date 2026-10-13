import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { abandonmentApi } from "../endpoints/abandonment.api";
import type { AbandonmentDateRange, ListAbandonmentsParams } from "../types/abandonment.types";

export const abandonmentKeys = {
  all: ["abandonments"] as const,
  lists: () => [...abandonmentKeys.all, "list"] as const,
  list: (params: ListAbandonmentsParams) => [...abandonmentKeys.lists(), params] as const,
  items: () => [...abandonmentKeys.all, "items"] as const,
  distribution: (range: AbandonmentDateRange) => [...abandonmentKeys.all, "distribution", range] as const,
  mySummary: () => [...abandonmentKeys.all, "mySummary"] as const,
  telecallers: () => [...abandonmentKeys.all, "telecallers"] as const,
  detail: (id: string) => [...abandonmentKeys.all, "detail", id] as const,
  orderPrefill: (id: string) => [...abandonmentKeys.all, "orderPrefill", id] as const,
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

export function abandonmentItemOptionsQueryOptions() {
  return queryOptions({ queryKey: abandonmentKeys.items(), queryFn: () => abandonmentApi.listItems(), staleTime: 60 * 1000 });
}

/** Read fresh each time the Create Order form opens (never a cached copy), and never retried into a different checkout. */
export function abandonmentOrderPrefillQueryOptions(id: string) {
  return queryOptions({ queryKey: abandonmentKeys.orderPrefill(id), queryFn: () => abandonmentApi.orderPrefill(id), staleTime: 0, gcTime: 0, retry: false });
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

// All three live under abandonmentKeys.all, so an assignment (which invalidates that prefix) refreshes the dashboards and the lists together.
export function abandonmentDistributionQueryOptions(range: AbandonmentDateRange) {
  return queryOptions({ queryKey: abandonmentKeys.distribution(range), queryFn: () => abandonmentApi.distribution(range), staleTime: 15 * 1000 });
}

export function myAbandonmentSummaryQueryOptions() {
  return queryOptions({ queryKey: abandonmentKeys.mySummary(), queryFn: () => abandonmentApi.mySummary(), staleTime: 15 * 1000 });
}

export function assignableTelecallersQueryOptions() {
  return queryOptions({ queryKey: abandonmentKeys.telecallers(), queryFn: () => abandonmentApi.telecallers(), staleTime: 60 * 1000 });
}

