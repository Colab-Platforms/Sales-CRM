import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { ticketsApi } from "../endpoints/tickets.api";
import type { TicketListParams } from "../types/tickets.types";

export const ticketsKeys = {
  all: ["tickets"] as const,
  list: (params: TicketListParams) => [...ticketsKeys.all, "list", params] as const,
  detail: (id: string) => [...ticketsKeys.all, "detail", id] as const,
  openCount: () => [...ticketsKeys.all, "open-count"] as const,
};

// Live inbox: a ticket or reply from the other side shows up without a manual reload.
export const ticketListQueryOptions = (params: TicketListParams) =>
  queryOptions({ queryKey: ticketsKeys.list(params), queryFn: () => ticketsApi.list(params), staleTime: 10_000, placeholderData: keepPreviousData, refetchInterval: 30_000, refetchOnWindowFocus: true });

export const ticketDetailQueryOptions = (id: string) =>
  queryOptions({ queryKey: ticketsKeys.detail(id), queryFn: () => ticketsApi.get(id), staleTime: 5_000, refetchInterval: 20_000 });

/** Sidebar badge: tickets still open or in progress in this user's scope. */
export const openTicketCountQueryOptions = () =>
  queryOptions({ queryKey: ticketsKeys.openCount(), queryFn: () => ticketsApi.openCount(), staleTime: 30_000, refetchInterval: 60_000, retry: false });
