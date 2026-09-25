import { queryOptions } from "@tanstack/react-query";
import { callingApi } from "../endpoints/calling.api";

export const callingKeys = {
  all: ["calling"] as const,
  virtualNumbers: () => [...callingKeys.all, "virtual-numbers"] as const,
  allVirtualNumbers: () => [...callingKeys.all, "virtual-numbers", "all"] as const,
  leadCalls: (leadId: string) => [...callingKeys.all, "lead", leadId, "calls"] as const,
  outcomes: () => [...callingKeys.all, "outcomes"] as const,
};

export function virtualNumbersQueryOptions() {
  return queryOptions({
    queryKey: callingKeys.virtualNumbers(),
    queryFn: callingApi.listVirtualNumbers,
  });
}

export function allVirtualNumbersQueryOptions() {
  return queryOptions({
    queryKey: callingKeys.allVirtualNumbers(),
    queryFn: callingApi.listAllVirtualNumbers,
  });
}

export function leadCallsQueryOptions(leadId: string) {
  return queryOptions({
    queryKey: callingKeys.leadCalls(leadId),
    queryFn: () => callingApi.listLeadCalls(leadId),
  });
}

export function callOutcomesQueryOptions() {
  return queryOptions({
    queryKey: callingKeys.outcomes(),
    queryFn: callingApi.listCallOutcomes,
    staleTime: 5 * 60 * 1000, // a fixed, rarely-changing list
  });
}
