"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Forward, MessagesSquare, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { whatsappMessageListQueryOptions } from "@/lib/api-client/queries/whatsapp-history.queries";
import { useBulkDeleteMessagesForMeMutation, useDeleteMessageForMeMutation } from "@/lib/api-client/mutations/whatsapp-history.mutations";
import { useAuthStore } from "@/stores/auth-store";
import { MessageBubble } from "./message-bubble";
import { MessageDetailDialog } from "../conversation/message-detail-dialog";
import { ForwardMessageDialog } from "./forward-message-dialog";
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
export function ConversationChat({
  leadId,
  onReply,
  onCorrect,
}: {
  leadId: string;
  onReply?: (message: WhatsAppMessageHistoryItem) => void;
  onCorrect?: (message: WhatsAppMessageHistoryItem) => void;
}) {
  const token = useAuthStore((s) => s.token);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_STEP);
  const [selected, setSelected] = useState<WhatsAppMessageHistoryItem | null>(null);
  const [forwardTarget, setForwardTarget] = useState<WhatsAppMessageHistoryItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WhatsAppMessageHistoryItem | null>(null);
  // WhatsApp-style multi-select: entered via a bubble's own "Select" menu action or its selection
  // checkbox once active - a pure CRM UI concern, never anything persisted or sent to the provider.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLeadId = useRef(leadId);
  const prevCount = useRef(0);

  const deleteForMe = useDeleteMessageForMeMutation();
  const bulkDeleteForMe = useBulkDeleteMessagesForMeMutation();

  // Switching conversations starts back at the latest page-size window and leaves selection mode.
  useEffect(() => {
    if (prevLeadId.current !== leadId) {
      prevLeadId.current = leadId;
      setPageSize(PAGE_SIZE_STEP);
      prevCount.current = 0;
      setSelectionMode(false);
      setSelectedIds(new Set());
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
  // Part 1 (WhatsApp Inbox reply association): resolves a message's real replyToProviderMessageId
  // (Meta's context.id) against messages already loaded in this same window - never a separate fetch,
  // never a guessed relationship. A reply to a message outside the currently loaded page simply
  // renders without the quoted preview, rather than fetching further back for it.
  const byProviderMessageId = new Map(messages.filter((m) => m.providerMessageId).map((m) => [m.providerMessageId as string, m]));
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

  function toggleSelect(message: WhatsAppMessageHistoryItem) {
    setSelectionMode(true);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(message.id)) next.delete(message.id);
      else next.add(message.id);
      return next;
    });
  }

  function cancelSelection() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  function confirmDeleteForMe() {
    if (!deleteTarget) return;
    deleteForMe.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
      onError: (err) => toast.error(getErrorMessage(err, "Could not delete the message.")),
    });
  }

  function confirmBulkDeleteForMe() {
    bulkDeleteForMe.mutate([...selectedIds], {
      onSuccess: () => {
        setBulkDeleteOpen(false);
        cancelSelection();
      },
      onError: (err) => toast.error(getErrorMessage(err, "Could not delete the selected messages.")),
    });
  }

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
    <div className="flex h-full min-h-0 flex-col">
      {selectionMode ? (
        <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" onClick={cancelSelection} aria-label="Cancel selection">
              <X className="size-4" />
            </Button>
            <span className="text-sm font-medium">{selectedIds.size} selected</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={selectedIds.size !== 1}
              title={selectedIds.size !== 1 ? "Select exactly one text message to forward" : undefined}
              onClick={() => {
                const only = messages.find((m) => selectedIds.has(m.id));
                if (only) setForwardTarget(only);
              }}
            >
              <Forward data-icon="inline-start" />
              Forward
            </Button>
            <Button variant="ghost" size="sm" disabled={selectedIds.size === 0} onClick={() => setBulkDeleteOpen(true)} className="text-destructive hover:text-destructive">
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          </div>
        </div>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
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
                <MessageBubble
                  message={message}
                  onSelect={() => setSelected(message)}
                  replyTo={message.replyToProviderMessageId ? byProviderMessageId.get(message.replyToProviderMessageId) : undefined}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(message.id)}
                  onToggleSelect={() => toggleSelect(message)}
                  onReply={(m) => onReply?.(m)}
                  onCorrect={(m) => onCorrect?.(m)}
                  onForward={(m) => setForwardTarget(m)}
                  onDeleteForMe={(m) => setDeleteTarget(m)}
                />
              </div>
            );
          })}
        </div>
      </div>

      <MessageDetailDialog message={selected} onOpenChange={(open) => !open && setSelected(null)} />
      <ForwardMessageDialog message={forwardTarget} onOpenChange={(open) => !open && setForwardTarget(null)} />

      <ConfirmActionDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete message?"
        description="This removes the message from your own CRM view only - it stays visible to any other CRM user, and nothing is deleted from the customer's actual WhatsApp."
        confirmLabel="Delete for me"
        pendingLabel="Deleting…"
        pending={deleteForMe.isPending}
        destructive
        onConfirm={confirmDeleteForMe}
      />

      <ConfirmActionDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`Delete ${selectedIds.size} message${selectedIds.size === 1 ? "" : "s"}?`}
        description="This removes them from your own CRM view only - they stay visible to any other CRM user, and nothing is deleted from the customer's actual WhatsApp. WhatsApp Business does not support deleting a sent message for everyone."
        confirmLabel="Delete for me"
        pendingLabel="Deleting…"
        pending={bulkDeleteForMe.isPending}
        destructive
        onConfirm={confirmBulkDeleteForMe}
      />
    </div>
  );
}
