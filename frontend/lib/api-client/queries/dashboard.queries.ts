import { queryOptions } from "@tanstack/react-query";
import { dashboardApi } from "../endpoints/dashboard.api";

export const dashboardKeys = {
  all: ["dashboard"] as const,
  detail: () => [...dashboardKeys.all, "detail"] as const,
};

export function dashboardQueryOptions() {
  return queryOptions({
    queryKey: dashboardKeys.detail(),
    queryFn: dashboardApi.get,
  });
}
