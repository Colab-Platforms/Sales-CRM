import { queryOptions } from "@tanstack/react-query";
import { managerApi } from "../endpoints/manager.api";

export const managerKeys = {
  all: ["manager"] as const,
  groups: () => [...managerKeys.all, "groups"] as const,
  salespersons: () => [...managerKeys.all, "salespersons"] as const,
  mySalespersons: () => [...managerKeys.all, "salespersons", "mine"] as const,
};

export function groupsQueryOptions() {
  return queryOptions({
    queryKey: managerKeys.groups(),
    queryFn: managerApi.listGroups,
  });
}

export function salespersonsQueryOptions() {
  return queryOptions({
    queryKey: managerKeys.salespersons(),
    queryFn: managerApi.listSalespersons,
  });
}

export function mySalespersonsQueryOptions() {
  return queryOptions({
    queryKey: managerKeys.mySalespersons(),
    queryFn: managerApi.listMySalespersons,
  });
}
