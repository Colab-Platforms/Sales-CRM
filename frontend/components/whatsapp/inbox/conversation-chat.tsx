"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage } from "@/lib/api-client/client";
import { whatsappMessageListQueryOptions } from "@/lib/api-client/queries/whatsapp-history.queries";
import { useAuthStore } from "@/stores/auth-store";
import { MessageBubble } from "./message-bubble";
import { MessageDetailDialog } from "../conversation/message-detail-dialog";
import type { WhatsAppMessageHistoryItem } from "@/lib/api-client/types/whatsapp-history.types";

const PAGE_SIZE_STEP = 30;
const MAX_PAGE_SIZE = 100; // backend's own cap (whatsapp.history.validators.ts) - never exceeded
const DATE_SEPARATOR_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function messageDay(message: WhatsAppMessageHistoryItem): string {
  const at = message.direction === "OUTBOUND" ? (message.sentAt ?? message.createdAt) : (message.receivedAt ?? message.createdAt);
  return at ? new Date(at).toDateString() : "";
}

// Renders the SAME whatsappMessageListQueryOptions/WhatsAppMessageHistoryItem data the existing
// history-list view (WhatsAppConversation, used by Customer 360) already fetches - this is only a
// different renderer (chat bubbles instead of a list) for the Inbox, never a second data source or
// a second send path. Growing `pageSize` on the SAME page-1 query (rather than tracking separate
// pages) means a post-send invalidation of whatsappHistoryKeys.all naturally refetches exactly what
// is on screen, latest message included, with no manual merge/dedupe logic to get wrong.
export function ConversationChat({ leadId }: { leadId: string }) {
  const token = useAuthStore((s) => s.token);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_STEP);
  const [selected, setSelected] = useState<WhatsAppMessageHistoryItem | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLeadId = useRef(leadId);
  const prevCount = useRef(0);

  // Switching conversations starts back at the latest page-size window.
  useEffect(() => {
    if (prevLeadId.current !== leadId) {
      prevLeadId.current = leadId;
      setPageSize(PAGE_SIZE_STEP);
      prevCount.current = 0;
    }
  }, [leadId]);

  const params = { page: 1, pageSize, leadId };
  const query = useQuery({ ...whatsappMessageListQueryOptions(params), enabled: Boolean(token) });
  const data = query.data;
  const isLoading = query.isPending && query.fetchStatus !== "idle";
  const error = query.isError ? getErrorMessage(query.error, "Failed to load this conversation.") : null;

  // Oldest at top, newest at bottom - the backend list itself stays newest-first (E7.4's own
  // contract, used elsewhere); this reverses only the displayed slice, client-side.
  const messages = data ? [...data.items].reverse() : [];
  const canLoadOlder = Boolean(data) && data!.pagination.totalItems > messages.length && pageSize < MAX_PAGE_SIZE;

  // Scroll to the newest message whenever the conversation is opened or grows with a new message
  // (not when older history is loaded at the top, which would otherwise yank the view down).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !data) return;
    const grewAtBottom = data.pagination.totalItems !== prevCount.current && prevCount.current !== 0 && pageSize === PAGE_SIZE_STEP;
    const isFirstLoad = prevCount.current === 0;
    if (isFirstLoad || grewAtBottom) el.scrollTop = el.scrollHeight;
    prevCount.current = data.pagination.totalItems;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.items.map((m) => m.id).join(","), leadId]);

  if (isLoading) {
    return (
      <div className="flex h-full flex-col justify-end gap-3 p-4">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="ml-auto h-10 w-1/2" />
        <Skeleton className="h-10 w-3/5" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </div>
    );
  }

  if (!data || data.items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
        <MessagesSquare className="size-8 opacity-40" />
        <p className="text-sm">No messages yet.</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto p-4">
      {canLoadOlder ? (
        <div className="mb-3 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setPageSize((n) => Math.min(n + PAGE_SIZE_STEP, MAX_PAGE_SIZE))} disabled={query.isFetching}>
            {query.isFetching ? "Loading…" : "Load earlier messages"}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {messages.map((message, i) => {
          const day = messageDay(message);
          const showSeparator = i === 0 || day !== messageDay(messages[i - 1]!);
          return (
            <div key={message.id}>
              {showSeparator && day ? (
                <div className="my-3 flex justify-center">
                  <span className="rounded-full bg-muted px-3 py-1 text-[0.7rem] font-medium text-muted-foreground">
                    {DATE_SEPARATOR_FORMAT.format(new Date(day))}
                  </span>
                </div>
              ) : null}
              <MessageBubble message={message} onSelect={() => setSelected(message)} />
            </div>
          );
        })}
      </div>
      <MessageDetailDialog message={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}
