import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { performanceMatrixApi } from "../endpoints/performance-matrix.api";
import type { MatrixQuery } from "../types/performance-matrix.types";

export const performanceMatrixKeys = {
  all: ["performance-matrix"] as const,
  report: (q: MatrixQuery) => [...performanceMatrixKeys.all, "report", q] as const,
};

/** Re-read every minute while open, so today's hours fill in as calls and orders arrive. */
export function performanceMatrixQueryOptions(q: MatrixQuery) {
  return queryOptions({
    queryKey: performanceMatrixKeys.report(q),
    queryFn: () => performanceMatrixApi.get(q),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}
