import { queryOptions } from "@tanstack/react-query";
import { sourceApi } from "../endpoints/source.api";

export const sourceKeys = {
  all: ["sources"] as const,
  list: () => [...sourceKeys.all, "list"] as const,
  events: (id: string) => [...sourceKeys.all, id, "events"] as const,
};

export function sourcesQueryOptions() {
  return queryOptions({
    queryKey: sourceKeys.list(),
    queryFn: sourceApi.listSources,
  });
}

export function sourceEventsQueryOptions(id: string) {
  return queryOptions({
    queryKey: sourceKeys.events(id),
    queryFn: () => sourceApi.listSourceEvents(id),
  });
}
