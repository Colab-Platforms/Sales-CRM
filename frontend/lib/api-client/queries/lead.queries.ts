import { queryOptions } from "@tanstack/react-query";
import { leadApi } from "../endpoints/lead.api";
import type { BucketKind, LeadListParams } from "../types/lead.types";

export const leadKeys = {
  all: ["lead"] as const,
  list: (params: LeadListParams) => [...leadKeys.all, "list", params] as const,
  bucketSummary: (kind: BucketKind) => [...leadKeys.all, "bucket-summary", kind] as const,
  detail: (id: string) => [...leadKeys.all, "detail", id] as const,
  assignments: (id: string) => [...leadKeys.all, "assignments", id] as const,
  importBatch: (batchId: string) => [...leadKeys.all, "import", batchId] as const,
};

export function importProgressQueryOptions(batchId: string, enabled = true) {
  return queryOptions({
    queryKey: [...leadKeys.all, "import-progress", batchId] as const,
    queryFn: () => leadApi.getImportProgress(batchId),
    enabled,
    // poll while the import runs; stop once it has finished or stopped
    refetchInterval: (query) => (query.state.data && (query.state.data.status === "PROCESSING" || query.state.data.status === "DRAFT") ? 1500 : false),
  });
}

export function leadListQueryOptions(params: LeadListParams) {
  return queryOptions({
    queryKey: leadKeys.list(params),
    queryFn: () => leadApi.listLeads(params),
  });
}

export function bucketSummaryQueryOptions(kind: BucketKind = "LEAD") {
  return queryOptions({
    queryKey: leadKeys.bucketSummary(kind),
    queryFn: () => leadApi.getBucketSummary(kind),
    refetchInterval: 30_000,
  });
}

export function leadDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: leadKeys.detail(id),
    queryFn: () => leadApi.getLead(id),
  });
}

export function leadAssignmentsQueryOptions(id: string) {
  return queryOptions({
    queryKey: leadKeys.assignments(id),
    queryFn: () => leadApi.getAssignmentHistory(id),
  });
}
