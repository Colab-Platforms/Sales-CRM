import axios from "axios";
import { useQuery } from "@tanstack/react-query";
import { getErrorMessage } from "@/lib/api-client/client";
import { conversationCustomerQueryOptions } from "@/lib/api-client/queries/whatsapp-conversation.queries";
import { useAuthStore } from "@/stores/auth-store";

/**
 * The customer (Customer 360 data) behind a WhatsApp conversation, for the Inbox's header and right-hand panel. Keyed by the conversation's lead, so switching conversations never shows the
 * previous customer's data. `notFound` is true ONLY when no customer is linked to the conversation (a real 404); an authorization or server failure is returned as `error` and is never
 * turned into "Customer not found".
 */
export function useConversationCustomer(leadId: string) {
  const token = useAuthStore((s) => s.token);
  const query = useQuery({ ...conversationCustomerQueryOptions(leadId), enabled: Boolean(token) && Boolean(leadId) });
  const notFound = axios.isAxiosError(query.error) && query.error.response?.status === 404;
  return {
    data: query.data ?? null,
    isLoading: query.isPending,
    notFound,
    error: query.error && !notFound ? getErrorMessage(query.error, "Could not load this customer.") : null,
    refetch: query.refetch,
    isFetching: query.isFetching,
  };
}
