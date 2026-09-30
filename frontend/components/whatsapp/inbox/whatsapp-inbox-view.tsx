"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MessageCircle, MessagesSquare, Plus, Search } from "lucide-react";
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
import { useArchiveConversationMutation, useMarkConversationReadMutation, useUnarchiveConversationMutation } from "@/lib/api-client/mutations/whatsapp-conversation.mutations";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { toast } from "sonner";
import { ConversationContextPanel } from "./conversation-context-panel";
import { useCustomer360 } from "@/hooks/useCustomers";
import { useAuthStore } from "@/stores/auth-store";
import { SendWhatsAppDialog } from "@/components/whatsapp/send-whatsapp-dialog";
import { DeleteCustomerDialog } from "@/components/customers/delete-customer-dialog";
import { ConversationChat } from "./conversation-chat";
import { ConversationListItem } from "./conversation-list-item";
import { CreateOrderDialog } from "./create-order-dialog";
import { BulkSendDialog } from "./bulk-send-dialog";
import { MessageComposer } from "./message-composer";
import { NewChatDialog } from "./new-chat-dialog";
import { CreateLeadDialog } from "@/components/leads/create-lead-dialog";

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
  // Active (default) vs Archived: the backend decides what "archived" means - this only asks for the right list.
  const [archivedView, setArchivedView] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<{ leadId: string; name: string; archived: boolean } | null>(null);
  const archive = useArchiveConversationMutation();
  const unarchive = useUnarchiveConversationMutation();
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Part 3 (WhatsApp Inbox): selection mode for bulk-sending a template to several selected chats at
  // once. Off by default so the normal "click a chat to open it" behavior is unaffected.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkSendOpen, setBulkSendOpen] = useState(false);

  function toggleSelectionMode() {
    setSelectionMode((prev) => !prev);
    setSelectedIds(new Set());
  }

  function toggleOne(leadId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(leadId)) next.delete(leadId);
      else next.add(leadId);
      return next;
    });
  }

  // Same debounce idiom as send-whatsapp-dialog.tsx's template preview - avoids firing a request per keystroke.
  function handleSearchChange(value: string) {
    setSearchInput(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setSearch(value);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
  }

  const params = { page, pageSize: PAGE_SIZE, search: search || undefined, archived: archivedView || undefined };

  function confirmArchiveToggle() {
    if (!archiveTarget) return;
    const mutation = archiveTarget.archived ? unarchive : archive;
    mutation.mutate(
      { leadId: archiveTarget.leadId, variables: undefined },
      {
        onSuccess: () => {
          toast.success(archiveTarget.archived ? "Conversation restored to the inbox." : "Conversation archived. The customer, orders and payments were not affected.");
          if (selectedLeadId === archiveTarget.leadId) onSelect("");
          setArchiveTarget(null);
        },
        onError: (error) => toast.error(getErrorMessage(error, "Could not update the conversation.")),
      },
    );
  }
  // 15s polling - the only "live" mechanism this app has (no websocket/SSE), enough to surface a new
  // inbound message or an AI reply/handoff while the inbox is open.
  const query = useQuery({ ...whatsappConversationListQueryOptions(params), enabled: Boolean(token), refetchInterval: 15_000 });
  const data = query.data;
  const isLoading = query.isPending && query.fetchStatus !== "idle";
  const error = query.isError ? getErrorMessage(query.error, "Failed to load conversations.") : null;

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="border-b p-3">
        <div className="mb-2 flex items-center justify-between gap-1">
          <div className="flex gap-1 text-xs" role="tablist" aria-label="Inbox view">
            {([false, true] as const).map((isArchived) => (
              <button
                key={String(isArchived)}
                type="button"
                role="tab"
                aria-selected={archivedView === isArchived}
                onClick={() => {
                  setArchivedView(isArchived);
                  setPage(1);
                }}
                className={cn("rounded-full px-3 py-1 font-medium transition-colors", archivedView === isArchived ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
              >
                {isArchived ? "Archived" : "Inbox"}
              </button>
            ))}
          </div>
          <Button type="button" size="sm" variant={selectionMode ? "secondary" : "ghost"} onClick={toggleSelectionMode}>
            {selectionMode ? "Cancel" : "Select"}
          </Button>
        </div>
        {selectionMode ? (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-medium">{selectedIds.size} chat{selectedIds.size === 1 ? "" : "s"} selected</span>
              <button type="button" className="text-primary hover:underline" onClick={() => setSelectedIds(new Set((data?.items ?? []).map((c) => c.leadId)))}>
                Select all
              </button>
              <button type="button" className="text-muted-foreground hover:underline" onClick={() => setSelectedIds(new Set())}>
                Clear selection
              </button>
            </div>
            <Button type="button" size="sm" disabled={selectedIds.size === 0} onClick={() => setBulkSendOpen(true)}>
              Send Template
            </Button>
          </div>
        ) : null}
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
              {search ? "No conversations match your search." : archivedView ? "No archived conversations." : "No WhatsApp conversations yet."}
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
                onArchiveToggle={() => setArchiveTarget({ leadId: conversation.leadId, name: conversation.name, archived: conversation.archived })}
                selectionMode={selectionMode}
                checked={selectedIds.has(conversation.leadId)}
                onToggleSelect={() => toggleOne(conversation.leadId)}
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

      <ConfirmActionDialog
        open={archiveTarget !== null}
        onOpenChange={(next) => (next ? undefined : setArchiveTarget(null))}
        title={archiveTarget?.archived ? "Restore this conversation?" : "Archive this conversation?"}
        description={
          archiveTarget?.archived
            ? `${archiveTarget.name}'s conversation will move back to your inbox.`
            : "It leaves your inbox and moves to Archived. The customer, orders, payments and message history are not deleted, and a new message from the customer brings it back automatically."
        }
        confirmLabel={archiveTarget?.archived ? "Restore" : "Archive"}
        pendingLabel={archiveTarget?.archived ? "Restoring…" : "Archiving…"}
        pending={archive.isPending || unarchive.isPending}
        onConfirm={confirmArchiveToggle}
      />

      <BulkSendDialog
        open={bulkSendOpen}
        onOpenChange={setBulkSendOpen}
        leadIds={Array.from(selectedIds)}
        onSent={() => {
          setSelectionMode(false);
          setSelectedIds(new Set());
        }}
      />
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
  const archiveMutation = useArchiveConversationMutation();
  const unarchiveMutation = useUnarchiveConversationMutation();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteCustomerOpen, setDeleteCustomerOpen] = useState(false);
  // "Delete Chat" reuses the existing archive/unarchive infrastructure (Part 7): nothing here ever
  // deletes messages. Archiving is the safe removal that already exists end-to-end, and the backend
  // (not this component) decides what "archived" means.
  const isArchived = conversation.data?.archived ?? false;

  function confirmArchive() {
    const mutation = isArchived ? unarchiveMutation : archiveMutation;
    mutation.mutate(
      { leadId, variables: undefined },
      {
        onSuccess: () => {
          toast.success(isArchived ? "Conversation restored to the inbox." : "Conversation deleted from your active Inbox. Customer and order records were not deleted.");
          setArchiveOpen(false);
          onBack();
        },
        onError: (err) => toast.error(getErrorMessage(err, "Could not update the conversation.")),
      },
    );
  }

  useEffect(() => {
    if (unread > 0) markRead.mutate({ leadId, variables: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the unread count changes for this conversation
  }, [leadId, unread]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* Sticky header: back (mobile only), name/mobile/lead number, provider/service-window info.
            Create Order, Send WhatsApp, Delete Chat and Delete Customer live in the Actions card on
            the right (Part 6) - always visible below, never lg-only, since it sits in this same flex row. */}
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
                    {/* Meta Cloud API is the CRM's only active WhatsApp provider - this never names a
                        provider or exposes a per-conversation provider restriction, only whether a
                        free-text reply can be sent right now (open service window) or a template is
                        needed instead. */}
                    {capability.freeText.allowed && capability.serviceWindow.open && capability.serviceWindow.expiresAt
                      ? `Free text available until ${new Date(capability.serviceWindow.expiresAt).toLocaleString()}`
                      : "Send an approved template to message this customer"}
                  </p>
                ) : null}
              </div>
            )}
          </div>
          {/* Below lg there is no right panel at all (see the Actions card at the bottom of this
              component), so the same actions stay reachable here instead of disappearing. */}
          <div className="flex gap-2 lg:hidden">
            <Button size="sm" variant="outline" onClick={() => setCreateOrderOpen(true)} disabled={!data}>
              Create Order
            </Button>
            <Button size="sm" onClick={() => setSendOpen(true)} disabled={!data?.profile.mobile}>
              Send WhatsApp
            </Button>
            {conversation.data ? (
              <Button size="sm" variant="outline" onClick={() => setArchiveOpen(true)}>
                {isArchived ? "Restore Chat" : "Delete Chat"}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDeleteCustomerOpen(true)} disabled={!data}>
              Delete Customer
            </Button>
          </div>
        </div>

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
      </div>

      {/* A genuinely stable fixed-width sidebar: min-w/max-w pin it to exactly 340px regardless of its
          own content, so a long customer name/email or an order with a long number can never push
          this column wider and squeeze the main conversation area. Explicit h-full (not just relying
          on flex "stretch") gives it a real, definite height from this row, which ConversationContextPanel's
          own h-full + overflow-y-auto needs to actually scroll instead of silently growing/collapsing. */}
      <div className="hidden h-full min-h-0 w-[340px] min-w-[340px] max-w-[340px] shrink-0 flex-col border-l lg:flex">
        <ConversationContextPanel
          leadId={leadId}
          canSendWhatsApp={Boolean(data?.profile.mobile)}
          onSendWhatsApp={() => setSendOpen(true)}
          onCreateOrder={() => setCreateOrderOpen(true)}
          isArchived={isArchived}
          onDeleteChat={() => setArchiveOpen(true)}
          onDeleteCustomer={() => setDeleteCustomerOpen(true)}
        />
      </div>

      <ConfirmActionDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={isArchived ? "Restore this conversation?" : "Delete conversation?"}
        description={isArchived ? "It will move back to your inbox." : "This will remove this conversation from the active Inbox. Customer and order records will not be deleted."}
        confirmLabel={isArchived ? "Restore" : "Delete Chat"}
        pendingLabel={isArchived ? "Restoring…" : "Deleting…"}
        destructive={!isArchived}
        pending={archiveMutation.isPending || unarchiveMutation.isPending}
        onConfirm={confirmArchive}
      />

      {data ? (
        <>
          <SendWhatsAppDialog open={sendOpen} onOpenChange={setSendOpen} leadId={leadId} customerName={data.profile.name} orders={data.orders} />
          <CreateOrderDialog open={createOrderOpen} onOpenChange={setCreateOrderOpen} leadId={leadId} customerName={data.profile.name} customerMobile={data.profile.mobile} />
          <DeleteCustomerDialog open={deleteCustomerOpen} onOpenChange={setDeleteCustomerOpen} leadId={leadId} customerName={data.profile.name} onDeactivated={onBack} />
        </>
      ) : null}
    </div>
  );
}

export function WhatsAppInboxView() {
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [createContactOpen, setCreateContactOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  // Picking a contact from "New Chat" never fabricates a conversation - it just hands their leadId to
  // the same SendWhatsAppDialog every other "Send WhatsApp" button already uses. A conversation only
  // exists once a real template is actually sent (or the customer messages in).
  const [newChatTarget, setNewChatTarget] = useState<{ leadId: string; name: string } | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">WhatsApp</h1>
          <p className="text-sm text-muted-foreground">All WhatsApp conversations you have access to, in one place.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Any customer can be reached here even with zero prior messages - the conversation list
              below is built only from existing WhatsAppMessage rows, so a contact with none can't
              appear there yet. This searches the same Customers data and opens the same Send
              WhatsApp dialog, never a second messaging path. */}
          <Button size="sm" variant="outline" onClick={() => setNewChatOpen(true)}>
            <MessageCircle data-icon="inline-start" />
            New Chat
          </Button>
          {/* Same Lead create flow the Customers page's "Create Contact" button already uses (POST
              /lead/leads) - a Lead IS the customer/contact record here, never a second, separate
              model. useCreateLeadMutation already invalidates the Customers cache, so the new
              contact is immediately findable from "New Chat" above with no page refresh. */}
          <Button size="sm" onClick={() => setCreateContactOpen(true)}>
            <Plus data-icon="inline-start" />
            Create Contact
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <CardContent className="grid h-[calc(100vh-14rem)] min-h-[420px] grid-cols-1 gap-0 p-0 md:grid-cols-[320px_1fr]">
          {/* Mobile/tablet: show either the list or the open chat, never both at once - selecting a
              conversation reveals the chat panel; the header's back button returns here. md+ shows
              list + chat side by side; the customer/order context pane (inside ConversationDetailPanel)
              only appears at lg+, since it needs the extra width. */}
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
        </CardContent>
      </Card>

      <CreateLeadDialog
        open={createContactOpen}
        onOpenChange={setCreateContactOpen}
        onDone={(lead) => {
          setCreateContactOpen(false);
          // Immediately usable from WhatsApp, no navigating to Leads: hands the just-created contact
          // straight to the exact same Send WhatsApp flow "New Chat" uses - never a fake conversation,
          // never a duplicate lookup, just this contact's real id/name from the create response itself.
          if (lead.mobile) setNewChatTarget({ leadId: lead.id, name: [lead.firstName, lead.lastName].filter(Boolean).join(" ") });
        }}
      />
      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        onSelect={(customer) => {
          setNewChatOpen(false);
          setNewChatTarget({ leadId: customer.leadId, name: customer.name });
        }}
      />
      {newChatTarget ? (
        <SendWhatsAppDialog
          open={Boolean(newChatTarget)}
          onOpenChange={(next) => {
            if (!next) setNewChatTarget(null);
          }}
          leadId={newChatTarget.leadId}
          customerName={newChatTarget.name}
          orders={[]}
        />
      ) : null}
    </div>
  );
}
