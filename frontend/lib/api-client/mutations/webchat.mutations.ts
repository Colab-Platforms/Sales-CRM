import { useMutation, useQueryClient } from "@tanstack/react-query";
import { webChatApi } from "../endpoints/webchat.api";
import { webChatKeys } from "../queries/webchat.queries";

// Every action invalidates the selected conversation's detail AND the whole queue, since an action
// (assign, handoff, archive...) can move a conversation in or out of the queue.
function invalidateAfterAction(queryClient: ReturnType<typeof useQueryClient>, id: string) {
  queryClient.invalidateQueries({ queryKey: webChatKeys.detail(id) });
  queryClient.invalidateQueries({ queryKey: webChatKeys.lists() });
}

export function useWebChatMarkReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => webChatApi.markRead(id),
    onSuccess: (_d, id) => invalidateAfterAction(queryClient, id),
  });
}

export function useWebChatAssignMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, assignedToId }: { id: string; assignedToId: string }) => webChatApi.assign(id, assignedToId),
    onSuccess: (_d, { id }) => invalidateAfterAction(queryClient, id),
  });
}

export function useWebChatHandoffMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => webChatApi.handoff(id),
    onSuccess: (_d, id) => invalidateAfterAction(queryClient, id),
  });
}

export function useWebChatReturnToAiMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => webChatApi.returnToAi(id),
    onSuccess: (_d, id) => invalidateAfterAction(queryClient, id),
  });
}

export function useWebChatArchiveMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => webChatApi.archive(id),
    onSuccess: (_d, id) => invalidateAfterAction(queryClient, id),
  });
}

export function useWebChatSendMessageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => webChatApi.sendMessage(id, text),
    onSuccess: (_d, { id }) => invalidateAfterAction(queryClient, id),
  });
}
