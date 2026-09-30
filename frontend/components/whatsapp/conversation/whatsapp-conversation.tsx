"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { getErrorMessage } from "@/lib/api-client/client";
import { whatsappMessageListQueryOptions } from "@/lib/api-client/queries/whatsapp-history.queries";
import { useAuthStore } from "@/stores/auth-store";
import { formatDateTime } from "@/lib/order-status";
import { MESSAGE_HISTORY_FILTER_LABELS, type MessageHistoryFilter } from "@/lib/whatsapp-message-status";
import type { ListMessagesParams, WhatsAppMessageHistoryItem } from "@/lib/api-client/types/whatsapp-history.types";
import { MessageStatusBadge } from "./message-status-badge";
import { MessageDetailDialog } from "./message-detail-dialog";

const PAGE_SIZE = 20;

function paramsForFilter(filter: MessageHistoryFilter): Pick<ListMessagesParams, "direction" | "status"> {
  switch (filter) {
    case "INBOUND":
    case "OUTBOUND":
      return { direction: filter };
    case "SENT":
    case "DELIVERED":
    case "READ":
    case "FAILED":
      return { status: filter };
    default:
      return {};
  }
}

function MessageRow({ message, onSelect }: { message: WhatsAppMessageHistoryItem; onSelect: () => void }) {
  const outbound = message.direction === "OUTBOUND";
  return (
    <li className="relative">
      <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-primary" aria-hidden="true" />
      <button type="button" onClick={onSelect} className="w-full text-left">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {outbound ? <ArrowUpRight className="size-3.5" /> : <ArrowDownLeft className="size-3.5" />}
          {outbound ? "Outgoing" : "Incoming"}
          {message.template ? ` · Template: ${message.template.name}` : null}
        </p>
        <p className="text-sm">{message.body || (message.template ? "(template message)" : "—")}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <MessageStatusBadge status={message.status} />
          {formatDateTime(outbound ? (message.sentAt ?? message.createdAt) : (message.receivedAt ?? message.createdAt))}
          {outbound && message.sentBy ? ` · Sent by ${message.sentBy.name}` : null}
          {message.order ? ` · Order ${message.order.orderNumber}` : null}
        </p>
        {message.status === "FAILED" && message.errorMessage ? (
          <p className="mt-0.5 text-xs text-destructive">Reason: {message.errorMessage}</p>
        ) : null}
      </button>
    </li>
  );
}

export function WhatsAppConversation({
  leadId,
  // Scopes this to only the messages tied to one specific order (Order Detail's use) instead of the
  // customer's whole history (Customer 360's use) - same query/component either way, never a second
  // WhatsApp-history implementation. Backend already supports this filter (whatsapp.history.filters.ts).
  orderId,
  title = "WhatsApp Conversation",
  emptyMessage = "No WhatsApp messages yet for this customer.",
  onStartWhatsApp,
}: {
  leadId: string;
  orderId?: string;
  title?: string;
  emptyMessage?: string;
  onStartWhatsApp?: () => void;
}) {
  const token = useAuthStore((s) => s.token);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<MessageHistoryFilter>("ALL");
  const [selected, setSelected] = useState<WhatsAppMessageHistoryItem | null>(null);

  const params: ListMessagesParams = { page, pageSize: PAGE_SIZE, leadId, orderId, ...paramsForFilter(filter) };
  const query = useQuery({ ...whatsappMessageListQueryOptions(params), enabled: Boolean(token) });

  const data = query.data;
  const isLoading = query.isPending && query.fetchStatus !== "idle";
  const error = query.isError ? getErrorMessage(query.error, "Failed to load WhatsApp conversation.") : null;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle>{title}</CardTitle>
        <Select
          value={filter}
          items={MESSAGE_HISTORY_FILTER_LABELS}
          onValueChange={(v) => {
            setFilter((v as MessageHistoryFilter) ?? "ALL");
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40" aria-label="Filter WhatsApp messages">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(MESSAGE_HISTORY_FILTER_LABELS) as MessageHistoryFilter[]).map((key) => (
              <SelectItem key={key} value={key}>
                {MESSAGE_HISTORY_FILTER_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className={query.isFetching ? "opacity-60 transition-opacity" : "transition-opacity"}>
        {isLoading ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading WhatsApp conversation">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : !data || data.items.length === 0 ? (
          filter === "ALL" ? (
            // No conversation exists yet - never faked/created just to have something to show here.
            // A real one starts the moment either side sends the first real message, which is exactly
            // what this button does (the same Send WhatsApp flow, not a second one).
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <p className="text-sm text-muted-foreground">{emptyMessage}</p>
              {onStartWhatsApp ? (
                <Button size="sm" onClick={onStartWhatsApp}>
                  <MessageCircle data-icon="inline-start" />
                  Start WhatsApp
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No messages match this filter.</p>
          )
        ) : (
          <>
            <ol className="space-y-4 border-l pl-4">
              {data.items.map((message) => (
                <MessageRow key={message.id} message={message} onSelect={() => setSelected(message)} />
              ))}
            </ol>
            <OrdersPagination pagination={data.pagination} onPageChange={setPage} disabled={query.isFetching} />
          </>
        )}
      </CardContent>
      <MessageDetailDialog message={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </Card>
  );
}
