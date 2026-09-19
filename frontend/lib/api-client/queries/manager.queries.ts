import { queryOptions } from "@tanstack/react-query";
import { managerApi } from "../endpoints/manager.api";

export const managerKeys = {
  all: ["manager"] as const,
  groups: () => [...managerKeys.all, "groups"] as const,
};

export function groupsQueryOptions() {
  return queryOptions({
    queryKey: managerKeys.groups(),
    queryFn: managerApi.listGroups,
  });
}
