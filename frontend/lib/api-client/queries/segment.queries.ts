import { queryOptions } from "@tanstack/react-query";
import { segmentApi } from "../endpoints/segment.api";

export const segmentKeys = {
  all: ["segments"] as const,
  list: (opts: { includeInactive?: boolean; counts?: boolean }) => [...segmentKeys.all, "list", opts] as const,
};

/** Active segments (tags and filters). Pass counts for the per-segment totals / assigned / unassigned. */
export function segmentsQueryOptions(opts: { includeInactive?: boolean; counts?: boolean } = {}) {
  return queryOptions({ queryKey: segmentKeys.list(opts), queryFn: () => segmentApi.list(opts), staleTime: 30_000 });
}
