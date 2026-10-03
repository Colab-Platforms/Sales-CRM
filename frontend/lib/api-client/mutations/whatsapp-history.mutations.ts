import { useMutation, useQueryClient } from "@tanstack/react-query";
import { whatsappHistoryApi } from "../endpoints/whatsapp-history.api";
import { whatsappHistoryKeys } from "../queries/whatsapp-history.queries";
import type { WhatsAppMessageHistoryItem, WhatsAppMessageListResult } from "../types/whatsapp-history.types";

// Patches every cached message-list page in place (no refetch) wherever the target message appears -
// the "targeted invalidation / optimistic update, never reload the whole conversation" requirement.
function patchMessageInLists(queryClient: ReturnType<typeof useQueryClient>, id: string, patch: Partial<WhatsAppMessageHistoryItem> | null) {
  queryClient.setQueriesData<WhatsAppMessageListResult>({ queryKey: whatsappHistoryKeys.all, exact: false }, (old) => {
    if (!old || !Array.isArray(old.items)) return old;
    if (patch === null) {
      // "Delete for me": the message disappears from THIS user's view only - removed from the
      // locally cached page, same as the server-side filter already excludes it on next fetch.
      if (!old.items.some((m) => m.id === id)) return old;
      return { ...old, items: old.items.filter((m) => m.id !== id), pagination: { ...old.pagination, totalItems: Math.max(0, old.pagination.totalItems - 1) } };
    }
    return { ...old, items: old.items.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
  });
  queryClient.setQueriesData<WhatsAppMessageHistoryItem>({ queryKey: whatsappHistoryKeys.detail(id) }, (old) => (old && patch ? { ...old, ...patch } : old));
}

export function useStarMessageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => whatsappHistoryApi.star(id),
    onMutate: (id) => patchMessageInLists(queryClient, id, { starred: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: whatsappHistoryKeys.all, predicate: (q) => q.queryKey[1] === "starred" }),
    onError: (_err, id) => patchMessageInLists(queryClient, id, { starred: false }),
  });
}

export function useUnstarMessageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => whatsappHistoryApi.unstar(id),
    onMutate: (id) => patchMessageInLists(queryClient, id, { starred: false }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: whatsappHistoryKeys.all, predicate: (q) => q.queryKey[1] === "starred" }),
    onError: (_err, id) => patchMessageInLists(queryClient, id, { starred: true }),
  });
}

export function useDeleteMessageForMeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => whatsappHistoryApi.deleteForMe(id),
    // No rollback on error here - a failed "delete for me" means retrying is the safe default
    // (the row never actually disappears server-side on failure, so a stale optimistic removal is
    // self-correcting on the next real fetch); onError here just lets the caller show a toast.
    onMutate: (id) => patchMessageInLists(queryClient, id, null),
  });
}

export function useBulkDeleteMessagesForMeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => whatsappHistoryApi.bulkDeleteForMe(ids),
    onMutate: (ids) => ids.forEach((id) => patchMessageInLists(queryClient, id, null)),
  });
}

export function useForwardMessageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, targetLeadId }: { id: string; targetLeadId: string }) => whatsappHistoryApi.forward(id, targetLeadId),
    onSuccess: (_result, { targetLeadId }) => {
      // A real new outbound message now exists in the destination conversation - invalidate just
      // that conversation's own message lists, never the whole whatsapp-messages cache.
      queryClient.invalidateQueries({ queryKey: whatsappHistoryKeys.all, predicate: (q) => q.queryKey[1] === "list" && (q.queryKey[2] as { leadId?: string } | undefined)?.leadId === targetLeadId });
    },
  });
}
