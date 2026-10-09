import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { managerAnalyticsApi, managerApi } from "../endpoints/manager.api";
import type { AnalyticsQuery } from "../types/manager-analytics.types";

export const managerKeys = {
  all: ["manager"] as const,
  groups: () => [...managerKeys.all, "groups"] as const,
  mySalespersons: () => [...managerKeys.all, "salespersons", "mine"] as const,
};

export function groupsQueryOptions() {
  return queryOptions({
    queryKey: managerKeys.groups(),
    queryFn: managerApi.listGroups,
  });
}

export function mySalespersonsQueryOptions() {
  return queryOptions({
    queryKey: managerKeys.mySalespersons(),
    queryFn: managerApi.listMySalespersons,
  });
}

export const managerAnalyticsKeys = {
  overview: (q: AnalyticsQuery) => [...managerKeys.all, "analytics", q] as const,
  salesperson: (id: string, q: AnalyticsQuery) => [...managerKeys.all, "analytics", "salesperson", id, q] as const,
};

export function managerAnalyticsQueryOptions(q: AnalyticsQuery) {
  return queryOptions({
    queryKey: managerAnalyticsKeys.overview(q),
    queryFn: () => managerAnalyticsApi.overview(q),
    placeholderData: keepPreviousData,
  });
}

export function salespersonAnalyticsQueryOptions(id: string, q: AnalyticsQuery) {
  return queryOptions({
    queryKey: managerAnalyticsKeys.salesperson(id, q),
    queryFn: () => managerAnalyticsApi.salesperson(id, q),
    placeholderData: keepPreviousData,
  });
}
