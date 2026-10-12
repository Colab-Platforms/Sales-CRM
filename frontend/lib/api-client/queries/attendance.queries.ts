import { queryOptions } from "@tanstack/react-query";
import { attendanceApi } from "../endpoints/attendance.api";

export const attendanceKeys = {
  all: ["attendance"] as const,
  me: () => [...attendanceKeys.all, "me"] as const,
  team: () => [...attendanceKeys.all, "team"] as const,
  report: (date: string | undefined) => [...attendanceKeys.all, "report", date ?? "today"] as const,
};

// No refetchInterval anywhere: changes arrive over the SSE streams (see hooks/use-sse-stream.ts) and
// invalidate these queries; the ticking clocks are computed in the browser.
export function myShiftQueryOptions() {
  return queryOptions({
    queryKey: attendanceKeys.me(),
    queryFn: attendanceApi.getMine,
    staleTime: Infinity,
  });
}

export function teamStatusQueryOptions() {
  return queryOptions({
    queryKey: attendanceKeys.team(),
    queryFn: attendanceApi.getTeam,
    staleTime: Infinity,
  });
}

export function attendanceReportQueryOptions(date: string | undefined) {
  return queryOptions({
    queryKey: attendanceKeys.report(date),
    queryFn: () => attendanceApi.getReport({ date }),
  });
}
