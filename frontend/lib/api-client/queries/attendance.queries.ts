import { queryOptions } from "@tanstack/react-query";
import { keepPreviousData } from "@tanstack/react-query";
import { attendanceApi } from "../endpoints/attendance.api";
import type { AttendanceRecordsQuery } from "../types/attendance.types";

export const attendanceKeys = {
  all: ["attendance"] as const,
  me: () => [...attendanceKeys.all, "me"] as const,
  team: () => [...attendanceKeys.all, "team"] as const,
  breakLimit: () => [...attendanceKeys.all, "break-limit"] as const,
  report: (date: string | undefined) => [...attendanceKeys.all, "report", date ?? "today"] as const,
  records: (q: AttendanceRecordsQuery) => [...attendanceKeys.all, "records", q] as const,
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

export function breakLimitQueryOptions() {
  return queryOptions({
    queryKey: attendanceKeys.breakLimit(),
    queryFn: attendanceApi.getBreakLimit,
  });
}

/** Attendance records for the filters/reports. Re-read every minute so today's clock-ins appear without a reload. */
export function attendanceRecordsQueryOptions(q: AttendanceRecordsQuery) {
  return queryOptions({
    queryKey: attendanceKeys.records(q),
    queryFn: () => attendanceApi.getRecords(q),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}
