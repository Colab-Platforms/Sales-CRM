"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect } from "@/components/ui/native-select";
import { getErrorMessage } from "@/lib/api-client/client";
import { webChatListQueryOptions } from "@/lib/api-client/queries/webchat.queries";
import type { WebChatConversationListItem, WebChatListParams } from "@/lib/api-client/types/webchat.types";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import { WebChatConversationPanel } from "./webchat-conversation-panel";
import { FILTER_LABELS, displayName, filterToParams, isUnread, type WebChatQueueFilter } from "./webchat-helpers";

const SEARCH_DEBOUNCE_MS = 300;

const TIME_FORMAT = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" });

function QueueItem({ conversation, selected, onSelect }: { conversation: WebChatConversationListItem; selected: boolean; onSelect: () => void }) {
  const unread = isUnread(conversation);
  const contact = conversation.lead?.mobile ?? conversation.lead?.email ?? null;
  const stamp = conversation.lastMessageAt ?? conversation.createdAt;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected}
        className={cn(
          "flex w-full flex-col gap-1 border-b px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50",
          selected && "bg-muted",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate text-sm", unread ? "font-semibold" : "font-medium")}>{displayName(conversation)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{TIME_FORMAT.format(new Date(stamp))}</span>
        </div>
        {contact ? <span className="truncate text-xs text-muted-foreground">{contact}</span> : null}
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className={cn("rounded px-1.5 py-0.5 font-medium", conversation.mode === "HUMAN" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
            {conversation.mode === "HUMAN" ? "Human" : "AI"}
          </span>
          <span className="text-muted-foreground">{conversation.assignedTo ? conversation.assignedTo.name : "Unassigned"}</span>
          {conversation.productInterest ? <span className="truncate text-muted-foreground">· {conversation.productInterest}</span> : null}
          {unread ? <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="Unread" /> : null}
        </div>
      </button>
    </li>
  );
}

export function WebChatLiveQueueView() {
  const userId = useAuthStore((s) => s.user?.id);
  const [filter, setFilter] = useState<WebChatQueueFilter>("active");
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Same debounce as the WhatsApp Inbox search - avoids a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const params = useMemo(() => filterToParams(filter, page, search), [filter, page, search]);
  const query = useQuery({ ...webChatListQueryOptions(params), enabled: Boolean(userId) });

  const rows = useMemo(() => {
    const data = query.data?.data ?? [];
    return filter === "mine" ? data.filter((c) => c.assignedTo?.id === userId) : data;
  }, [query.data, filter, userId]);

  const totalPages = query.data?.pagination.totalPages ?? 1;

  function changeFilter(next: WebChatQueueFilter) {
    setFilter(next);
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Website Chat</h1>
        <p className="text-sm text-muted-foreground">
          Website visitors who asked for a human. Replies you send are saved in the CRM; delivery to the visitor is not connected yet.
        </p>
      </div>

      <Card className="overflow-hidden p-0">
        <CardContent className="grid h-[calc(100vh-14rem)] min-h-[420px] grid-cols-1 gap-0 p-0 md:grid-cols-[320px_1fr]">
          <div className={cn("flex min-h-0 flex-col border-b md:border-r md:border-b-0", selectedId ? "hidden md:flex" : "flex")}>
            <div className="space-y-2 border-b p-3">
              <NativeSelect
                aria-label="Queue view"
                value={filter}
                onChange={(e) => changeFilter(e.target.value as WebChatQueueFilter)}
              >
                {(Object.keys(FILTER_LABELS) as WebChatQueueFilter[]).map((key) => (
                  <option key={key} value={key}>
                    {FILTER_LABELS[key]}
                  </option>
                ))}
              </NativeSelect>
              <div className="relative">
                <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search name, phone, lead or chat id"
                  className="pl-8"
                  aria-label="Search website chats"
                />
              </div>
              {filter === "mine" ? (
                <p className="text-xs text-muted-foreground">Shows your chats from the current page of results only.</p>
              ) : null}
            </div>

            <div className={cn("min-h-0 flex-1 overflow-y-auto transition-opacity", query.isFetching && "opacity-60")}>
              {!userId || query.isPending ? (
                <div className="space-y-3 p-3" aria-busy="true" aria-label="Loading website chats">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : query.isError ? (
                <div className="space-y-2 p-3">
                  <p role="alert" className="text-sm text-destructive">
                    {getErrorMessage(query.error, "Failed to load website chats.")}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => query.refetch()}>
                    Try again
                  </Button>
                </div>
              ) : rows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 p-8 text-center">
                  <MessagesSquare className="size-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">
                    {search ? "No chats match your search." : filter === "archived" ? "No archived chats." : "No website chats waiting here."}
                  </p>
                </div>
              ) : (
                <ul>
                  {rows.map((conversation) => (
                    <QueueItem
                      key={conversation.id}
                      conversation={conversation}
                      selected={conversation.id === selectedId}
                      onSelect={() => setSelectedId(conversation.id)}
                    />
                  ))}
                </ul>
              )}
            </div>

            {query.data && query.data.pagination.totalPages > 1 ? (
              <div className="flex items-center justify-between gap-2 border-t p-2 text-xs">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span className="text-muted-foreground">
                  Page {page} of {totalPages}
                </span>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            ) : null}
          </div>

          <div className={cn("min-h-0", selectedId ? "block" : "hidden md:block")}>
            {selectedId ? (
              <WebChatConversationPanel conversationId={selectedId} onBack={() => setSelectedId(null)} onClosed={() => setSelectedId(null)} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <MessagesSquare className="size-10 opacity-40" />
                <p className="text-sm">Select a chat to view it.</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
