import { queryOptions } from "@tanstack/react-query";
import { webChatApi } from "../endpoints/webchat.api";
import type { WebChatListParams } from "../types/webchat.types";

export const webChatKeys = {
  all: ["webchat"] as const,
  lists: () => [...webChatKeys.all, "list"] as const,
  list: (params: WebChatListParams) => [...webChatKeys.lists(), params] as const,
  detail: (id: string) => [...webChatKeys.all, "detail", id] as const,
};

// Polling is the only live mechanism (no WebSocket/SSE/Redis) - same standard as the WhatsApp Inbox.
// React Query's refetchInterval already pauses while the tab is hidden (refetchIntervalInBackground
// defaults to false), so no extra visibility handling is needed. Each query owns exactly one timer.
export const WEBCHAT_QUEUE_POLL_MS = 15_000;
export const WEBCHAT_DETAIL_POLL_MS = 7_000;

export function webChatListQueryOptions(params: WebChatListParams) {
  return queryOptions({
    queryKey: webChatKeys.list(params),
    queryFn: () => webChatApi.list(params),
    refetchInterval: WEBCHAT_QUEUE_POLL_MS,
  });
}

export function webChatDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: webChatKeys.detail(id),
    queryFn: () => webChatApi.getDetail(id),
    refetchInterval: WEBCHAT_DETAIL_POLL_MS,
    // A 404 here means out of scope or missing - a stable answer, never worth retrying.
    retry: false,
  });
}
