"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MessageCircle, MessagesSquare, Search, ShoppingCart } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { customerDetailHref } from "@/components/orders/orders-table";
import { getErrorMessage } from "@/lib/api-client/client";
import { cn } from "@/lib/utils";
import { whatsappConversationListQueryOptions } from "@/lib/api-client/queries/whatsapp-history.queries";
import { conversationDetailQueryOptions, messagingCapabilityQueryOptions } from "@/lib/api-client/queries/whatsapp-conversation.queries";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import { useMarkConversationReadMutation } from "@/lib/api-client/mutations/whatsapp-conversation.mutations";
import { ConversationContextPanel } from "./conversation-context-panel";
import { useCustomer360 } from "@/hooks/useCustomers";
import { useAuthStore } from "@/stores/auth-store";
import { SendWhatsAppDialog } from "@/components/whatsapp/send-whatsapp-dialog";
import { ConversationChat } from "./conversation-chat";
import { ConversationListItem } from "./conversation-list-item";
import { CreateOrderDialog } from "./create-order-dialog";
import { MessageComposer } from "./message-composer";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

function ConversationListPanel({
  selectedLeadId,
  onSelect,
  className,
}: {
  selectedLeadId: string | null;
  onSelect: (leadId: string) => void;
  className?: string;
}) {
  const token = useAuthStore((s) => s.token);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Same debounce idiom as send-whatsapp-dialog.tsx's template preview - avoids firing a request per keystroke.
  function handleSearchChange(value: string) {
    setSearchInput(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setSearch(value);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
  }

  const params = { page, pageSize: PAGE_SIZE, search: search || undefined };
  // 15s polling - the only "live" mechanism this app has (no websocket/SSE), enough to surface a new
  // inbound message or an AI reply/handoff while the inbox is open.
  const query = useQuery({ ...whatsappConversationListQueryOptions(params), enabled: Boolean(token), refetchInterval: 15_000 });
  const data = query.data;
  const isLoading = query.isPending && query.fetchStatus !== "idle";
  const error = query.isError ? getErrorMessage(query.error, "Failed to load conversations.") : null;

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="border-b p-3">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search conversations…"
            className="pl-8"
            aria-label="Search WhatsApp conversations"
          />
        </div>
      </div>

      <div className={`min-h-0 flex-1 overflow-y-auto ${query.isFetching ? "opacity-60 transition-opacity" : "transition-opacity"}`}>
        {isLoading ? (
          <div className="space-y-3 p-3" aria-busy="true" aria-label="Loading conversations">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : error ? (
          <p role="alert" className="p-3 text-sm text-destructive">
            {error}
          </p>
        ) : !data || data.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-8 text-center">
            <MessagesSquare className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {search ? "No conversations match your search." : "No WhatsApp conversations yet."}
            </p>
          </div>
        ) : (
          <ul>
            {data.items.map((conversation) => (
              <ConversationListItem
                key={conversation.leadId}
                conversation={conversation}
                selected={conversation.leadId === selectedLeadId}
                onSelect={() => onSelect(conversation.leadId)}
              />
            ))}
          </ul>
        )}
      </div>

      {data && data.pagination.totalPages > 1 ? (
        <div className="border-t p-2">
          <OrdersPagination pagination={data.pagination} onPageChange={setPage} disabled={query.isFetching} />
        </div>
      ) : null}
    </div>
  );
}

function ConversationDetailPanel({ leadId, onBack }: { leadId: string; onBack: () => void }) {
  const { data, isLoading, error } = useCustomer360(leadId);
  const [sendOpen, setSendOpen] = useState(false);
  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  // A lead with messages predating the conversation model has no conversation row yet (404), so the detail query can be empty.
  // Whether free text is allowed is decided by the backend (active provider + Meta 24-hour service window) and only
  // displayed here - never inferred from the conversation row.
  const conversation = useQuery({ ...conversationDetailQueryOptions(leadId), retry: false });
  const capability = useQuery({ ...messagingCapabilityQueryOptions(leadId), retry: false }).data;
  const canSendFreeText = capability?.freeText.allowed ?? false;
  const markRead = useMarkConversationReadMutation();
  const unread = conversation.data?.unreadCount ?? 0;

  useEffect(() => {
    if (unread > 0) markRead.mutate({ leadId, variables: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the unread count changes for this conversation
  }, [leadId, unread]);

  return (
    <div className="flex h-full flex-col">
      {/* Sticky header: back (mobile only), name/mobile/lead number, link to Customer 360, Send WhatsApp. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onBack} aria-label="Back to conversations">
            <ArrowLeft />
          </Button>
          {isLoading ? (
            <Skeleton className="h-6 w-40" />
          ) : error || !data ? (
            <p className="text-sm text-destructive">{error ?? "Failed to load this customer."}</p>
          ) : (
            <div className="min-w-0">
              <Link href={customerDetailHref(leadId)} className="truncate font-semibold hover:underline">
                {data.profile.name}
              </Link>
              <p className="truncate text-xs text-muted-foreground">
                {data.profile.mobile ?? "No phone on file"} · {data.profile.leadNumber}
              </p>
              {capability ? (
                <p className="truncate text-xs text-muted-foreground" data-testid="conversation-provider">
                  Provider: <span className="font-medium text-foreground">{capability.activeProvider ? (PROVIDER_LABELS[capability.activeProvider] ?? capability.activeProvider) : "None yet"}</span>
                  {capability.activeProvider === "META"
                    ? capability.serviceWindow.open && capability.serviceWindow.expiresAt
                      ? ` · Service window open until ${new Date(capability.serviceWindow.expiresAt).toLocaleString()}`
                      : " · Service window closed - templates only"
                    : capability.activeProvider
                      ? " · Templates only"
                      : ""}
                </p>
              ) : null}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {/* E7.8 (WhatsApp -> CRM Order): identifies the lead from this open conversation
              automatically (leadId, already the whole panel's own prop) and reuses the exact same
              Order model / createManualOrder service every other order comes from - never a
              WhatsApp-only order record. Server-side RBAC (getLeadScope) is the real gate; this
              button is just always shown, since a conversation is only open here if it's already in
              the caller's scope. */}
          <Button size="sm" variant="outline" onClick={() => setCreateOrderOpen(true)} disabled={!data}>
            <ShoppingCart data-icon="inline-start" />
            Create Order
          </Button>
          <Button size="sm" onClick={() => setSendOpen(true)} disabled={!data?.profile.mobile}>
            <MessageCircle data-icon="inline-start" />
            Send WhatsApp
          </Button>
        </div>
      </div>

      {/* Scrollable chat area; the composer trigger lives in a sticky footer below it. */}
      <div className="min-h-0 flex-1">
        <ConversationChat leadId={leadId} />
      </div>

      {/* Sticky composer: a real, typable text box (per spec), but AiSensy's Campaign API - the
          only API this CRM sends through - has no free-text or media endpoint, only
          sendTemplateMessage(). MessageComposer never fakes a send for either; the only action that
          actually reaches the backend is the template button, which opens the same existing
          SendWhatsAppDialog/sendTemplate() path used everywhere else. */}
      <div className="border-t p-3">
        <MessageComposer leadId={leadId} canSendFreeText={canSendFreeText} blockedMessage={capability?.freeText.message ?? null} onOpenTemplateSend={() => setSendOpen(true)} disabled={!data?.profile.mobile} />
      </div>

      {data ? (
        <>
          <SendWhatsAppDialog open={sendOpen} onOpenChange={setSendOpen} leadId={leadId} customerName={data.profile.name} orders={data.orders} />
          <CreateOrderDialog open={createOrderOpen} onOpenChange={setCreateOrderOpen} leadId={leadId} customerName={data.profile.name} customerMobile={data.profile.mobile} />
        </>
      ) : null}
    </div>
  );
}

export function WhatsAppInboxView() {
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">WhatsApp</h1>
        <p className="text-sm text-muted-foreground">All WhatsApp conversations you have access to, in one place.</p>
      </div>

      <Card className="overflow-hidden p-0">
        <CardContent className="grid h-[calc(100vh-14rem)] min-h-[420px] grid-cols-1 gap-0 p-0 md:grid-cols-[320px_1fr] lg:grid-cols-[320px_1fr_340px]">
          {/* Mobile/tablet: show either the list or the open chat, never both at once - selecting a
              conversation reveals the chat panel; the header's back button returns here. md+ shows
              list + chat side by side; lg+ adds the customer/order context pane on the right. */}
          <div className={cn("min-h-0 border-b md:border-r md:border-b-0", selectedLeadId ? "hidden md:block" : "block")}>
            <ConversationListPanel selectedLeadId={selectedLeadId} onSelect={setSelectedLeadId} />
          </div>
          <div className={cn("min-h-0", selectedLeadId ? "block" : "hidden md:block")}>
            {selectedLeadId ? (
              <ConversationDetailPanel leadId={selectedLeadId} onBack={() => setSelectedLeadId(null)} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <MessagesSquare className="size-10 opacity-40" />
                <p className="text-sm">Select a conversation to start.</p>
              </div>
            )}
          </div>
          <div className="hidden min-h-0 border-l lg:block">
            {selectedLeadId ? <ConversationContextPanel leadId={selectedLeadId} /> : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
