import { queryOptions } from "@tanstack/react-query";
import { authApi } from "../endpoints/auth.api";

export const authKeys = {
  all: ["auth"] as const,
  me: () => [...authKeys.all, "me"] as const,
};

export function meQueryOptions() {
  return queryOptions({
    queryKey: authKeys.me(),
    queryFn: authApi.me,
  });
}
