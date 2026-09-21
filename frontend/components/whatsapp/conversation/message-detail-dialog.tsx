"use client";

import Link from "next/link";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { orderDetailHref } from "@/components/orders/orders-table";
import { formatDateTime } from "@/lib/order-status";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import { MessageStatusBadge } from "./message-status-badge";
import type { WhatsAppMessageHistoryItem } from "@/lib/api-client/types/whatsapp-history.types";

export function MessageDetailDialog({ message, onOpenChange }: { message: WhatsAppMessageHistoryItem | null; onOpenChange: (open: boolean) => void }) {
  if (!message) return null;

  return (
    <Dialog open={Boolean(message)} onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {message.direction === "OUTBOUND" ? "Outgoing message" : "Incoming message"}
            <MessageStatusBadge status={message.status} />
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Message</p>
            <p className="mt-1 rounded-lg border bg-muted/30 p-3 whitespace-pre-wrap">{message.body ?? "—"}</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Provider</p>
              <p>{PROVIDER_LABELS[message.provider] ?? message.provider}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Message type</p>
              <p>{message.messageType}</p>
            </div>
            {message.template ? (
              <div>
                <p className="text-xs text-muted-foreground">Template</p>
                <p>{message.template.name}</p>
              </div>
            ) : null}
            {message.order ? (
              <div>
                <p className="text-xs text-muted-foreground">Order</p>
                <Link href={orderDetailHref(message.order.id)} className="text-primary hover:underline">
                  {message.order.orderNumber}
                </Link>
              </div>
            ) : null}
            {message.sentBy ? (
              <div>
                <p className="text-xs text-muted-foreground">Sent by</p>
                <p>{message.sentBy.name}</p>
              </div>
            ) : null}
            {message.providerMessageId ? (
              <div>
                <p className="text-xs text-muted-foreground">Provider message ID</p>
                <p className="break-all">{message.providerMessageId}</p>
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">{message.direction === "OUTBOUND" ? "Sent" : "Received"}</p>
              <p>{formatDateTime(message.direction === "OUTBOUND" ? message.sentAt : message.receivedAt)}</p>
            </div>
            {message.deliveredAt ? (
              <div>
                <p className="text-xs text-muted-foreground">Delivered</p>
                <p>{formatDateTime(message.deliveredAt)}</p>
              </div>
            ) : null}
            {message.readAt ? (
              <div>
                <p className="text-xs text-muted-foreground">Read</p>
                <p>{formatDateTime(message.readAt)}</p>
              </div>
            ) : null}
          </div>

          {message.status === "FAILED" && message.errorMessage ? (
            <div>
              <p className="text-xs text-muted-foreground">Failure reason</p>
              <p className="mt-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive">{message.errorMessage}</p>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
