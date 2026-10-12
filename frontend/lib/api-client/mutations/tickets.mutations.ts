import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ticketsApi } from "../endpoints/tickets.api";
import { ticketsKeys } from "../queries/tickets.queries";
import type { CreateTicketInput, TicketComment, TicketStatus, TicketView } from "../types/tickets.types";

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ticketsKeys.all });
}

export function useCreateTicketMutation() {
  const refresh = useRefresh();
  return useMutation<TicketView, unknown, CreateTicketInput>({ mutationFn: (input) => ticketsApi.create(input), onSuccess: refresh });
}

export function useAddTicketCommentMutation() {
  const refresh = useRefresh();
  return useMutation<TicketComment, unknown, { id: string; body: string }>({ mutationFn: ({ id, body }) => ticketsApi.addComment(id, body), onSuccess: refresh });
}

export function useSetTicketStatusMutation() {
  const refresh = useRefresh();
  return useMutation<TicketView, unknown, { id: string; status: TicketStatus }>({ mutationFn: ({ id, status }) => ticketsApi.setStatus(id, status), onSuccess: refresh });
}
