import { queryOptions } from "@tanstack/react-query";
import { leadApi } from "../endpoints/lead.api";
import type { LeadListParams } from "../types/lead.types";

export const leadKeys = {
  all: ["lead"] as const,
  list: (params: LeadListParams) => [...leadKeys.all, "list", params] as const,
  detail: (id: string) => [...leadKeys.all, "detail", id] as const,
  assignments: (id: string) => [...leadKeys.all, "assignments", id] as const,
  importBatch: (batchId: string) => [...leadKeys.all, "import", batchId] as const,
};

export function leadListQueryOptions(params: LeadListParams) {
  return queryOptions({
    queryKey: leadKeys.list(params),
    queryFn: () => leadApi.listLeads(params),
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
