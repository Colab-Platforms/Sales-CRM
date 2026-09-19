import { queryOptions } from "@tanstack/react-query";
import { adminApi } from "../endpoints/admin.api";

export const adminKeys = {
  all: ["admin"] as const,
  managers: () => [...adminKeys.all, "managers"] as const,
};

export function managersQueryOptions() {
  return queryOptions({
    queryKey: adminKeys.managers(),
    queryFn: adminApi.listManagers,
  });
}
