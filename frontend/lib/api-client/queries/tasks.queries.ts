import { queryOptions } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth-store";
import { tasksApi } from "../endpoints/tasks.api";

export const tasksKeys = {
  all: ["tasks"] as const,
  myFollowUps: () => [...tasksKeys.all, "my-follow-ups"] as const,
};

export function myFollowUpsQueryOptions() {
  return queryOptions({
    queryKey: tasksKeys.myFollowUps(),
    queryFn: tasksApi.listMyFollowUps,
    // HR has no leads, so the backend refuses follow-ups for them (403). Don't even ask - this one guard
    // covers the bell, the global reminders and the call-conflict check, which all share this query.
    enabled: () => useAuthStore.getState().user?.role !== "HR",
    // No push channel exists, so reminders come from polling; the browser-side clock does the
    // exact-minute timing between polls.
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });
}
