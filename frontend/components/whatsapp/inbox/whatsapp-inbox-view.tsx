"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageCircle, MessagesSquare, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { getErrorMessage } from "@/lib/api-client/client";
import { whatsappConversationListQueryOptions } from "@/lib/api-client/queries/whatsapp-history.queries";
import { useCustomer360 } from "@/hooks/useCustomers";
import { useAuthStore } from "@/stores/auth-store";
import { WhatsAppConversation } from "@/components/whatsapp/conversation/whatsapp-conversation";
import { SendWhatsAppDialog } from "@/components/whatsapp/send-whatsapp-dialog";
import { ConversationListItem } from "./conversation-list-item";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

function ConversationListPanel({
  selectedLeadId,
  onSelect,
}: {
  selectedLeadId: string | null;
  onSelect: (leadId: string) => void;
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
  const query = useQuery({ ...whatsappConversationListQueryOptions(params), enabled: Boolean(token) });
  const data = query.data;
  const isLoading = query.isPending && query.fetchStatus !== "idle";
  const error = query.isError ? getErrorMessage(query.error, "Failed to load conversations.") : null;

  return (
    <div className="flex h-full flex-col">
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

function ConversationDetailPanel({ leadId }: { leadId: string }) {
  const { data, isLoading, error } = useCustomer360(leadId);
  const [sendOpen, setSendOpen] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        {isLoading ? (
          <Skeleton className="h-6 w-40" />
        ) : error || !data ? (
          <p className="text-sm text-destructive">{error ?? "Failed to load this customer."}</p>
        ) : (
          <div>
            <p className="font-semibold">{data.profile.name}</p>
            <p className="text-xs text-muted-foreground">{data.profile.mobile ?? "No phone on file"}</p>
          </div>
        )}
        <Button size="sm" onClick={() => setSendOpen(true)} disabled={!data?.profile.mobile}>
          <MessageCircle data-icon="inline-start" />
          Send WhatsApp
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <WhatsAppConversation leadId={leadId} />
      </div>

      {data ? (
        <SendWhatsAppDialog open={sendOpen} onOpenChange={setSendOpen} leadId={leadId} customerName={data.profile.name} orders={data.orders} />
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
        <CardContent className="grid h-[calc(100vh-14rem)] min-h-[420px] grid-cols-1 gap-0 p-0 md:grid-cols-[320px_1fr]">
          <div className="min-h-0 border-b md:border-r md:border-b-0">
            <ConversationListPanel selectedLeadId={selectedLeadId} onSelect={setSelectedLeadId} />
          </div>
          <div className="min-h-0">
            {selectedLeadId ? (
              <ConversationDetailPanel leadId={selectedLeadId} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <MessagesSquare className="size-10 opacity-40" />
                <p className="text-sm">Select a conversation to view its history.</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
