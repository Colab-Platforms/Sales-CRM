import { queryOptions } from "@tanstack/react-query";
import { adminApi } from "../endpoints/admin.api";

export const adminKeys = {
  all: ["admin"] as const,
  managers: () => [...adminKeys.all, "managers"] as const,
  salespersons: () => [...adminKeys.all, "salespersons"] as const,
  hr: () => [...adminKeys.all, "hr"] as const,
  groups: () => [...adminKeys.all, "groups"] as const,
  group: (groupId: string) => [...adminKeys.all, "groups", groupId] as const,
};

export function managersQueryOptions() {
  return queryOptions({
    queryKey: adminKeys.managers(),
    queryFn: adminApi.listManagers,
  });
}

export function adminSalespersonsQueryOptions() {
  return queryOptions({
    queryKey: adminKeys.salespersons(),
    queryFn: adminApi.listSalespersons,
  });
}

export function hrQueryOptions() {
  return queryOptions({
    queryKey: adminKeys.hr(),
    queryFn: adminApi.listHr,
  });
}

export function adminGroupsQueryOptions() {
  return queryOptions({
    queryKey: adminKeys.groups(),
    queryFn: adminApi.listGroups,
  });
}
