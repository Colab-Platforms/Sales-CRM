import { queryOptions } from "@tanstack/react-query";
import { tasksApi } from "../endpoints/tasks.api";

export const tasksKeys = {
  all: ["tasks"] as const,
  myFollowUps: () => [...tasksKeys.all, "my-follow-ups"] as const,
};

export function myFollowUpsQueryOptions() {
  return queryOptions({
    queryKey: tasksKeys.myFollowUps(),
    queryFn: tasksApi.listMyFollowUps,
    // No push channel exists, so reminders come from polling; the browser-side clock does the
    // exact-minute timing between polls.
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });
}
