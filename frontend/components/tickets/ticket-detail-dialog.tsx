"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAddTicketCommentMutation, useSetTicketStatusMutation } from "@/lib/api-client/mutations/tickets.mutations";
import { ticketDetailQueryOptions } from "@/lib/api-client/queries/tickets.queries";
import { formatDateTime } from "@/lib/order-status";
import { TICKET_CATEGORY_LABELS, TICKET_COMMENT_MAX, TICKET_STATUS_LABELS, allowedTicketTransitions } from "@/lib/ticket-status";
import { useAuthStore } from "@/stores/auth-store";
import type { TicketStatus } from "@/lib/api-client/types/tickets.types";
import { TicketPriorityBadge, TicketStatusBadge } from "./ticket-badges";

const ACTION_LABELS: Record<TicketStatus, string> = { OPEN: "Reopen", IN_PROGRESS: "Mark in progress", RESOLVED: "Mark resolved", CLOSED: "Close ticket" };

export function TicketDetailDialog({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const user = useAuthStore((s) => s.user);
  const [comment, setComment] = useState("");
  const detail = useQuery(ticketDetailQueryOptions(ticketId));
  const addComment = useAddTicketCommentMutation();
  const setStatus = useSetTicketStatusMutation();
  const ticket = detail.data;

  function send() {
    const body = comment.trim();
    if (!body) return;
    addComment.mutate(
      { id: ticketId, body },
      { onSuccess: () => setComment(""), onError: (e) => toast.error(getErrorMessage(e, "Could not add the comment.")) },
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>{ticket ? `#${ticket.ticketNumber} · ${ticket.subject}` : "Ticket"}</DialogTitle>
          <DialogDescription>
            {ticket ? `Raised by ${ticket.raisedBy.name} on ${formatDateTime(ticket.createdAt)}` : detail.error ? getErrorMessage(detail.error, "Could not load the ticket.") : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {ticket ? (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <TicketStatusBadge status={ticket.status} />
              <TicketPriorityBadge priority={ticket.priority} />
              <span className="text-xs text-muted-foreground">{TICKET_CATEGORY_LABELS[ticket.category]}</span>
              {ticket.resolvedAt ? (
                <span className="text-xs text-muted-foreground">
                  · {TICKET_STATUS_LABELS[ticket.status === "CLOSED" ? "CLOSED" : "RESOLVED"]} {formatDateTime(ticket.resolvedAt)}
                  {ticket.resolvedBy ? ` by ${ticket.resolvedBy.name}` : ""}
                </span>
              ) : null}
            </div>
            <p className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-sm">{ticket.description}</p>

            <div className="flex flex-wrap gap-2">
              {allowedTicketTransitions(user?.role, ticket.status).map((s) => (
                <Button
                  key={s}
                  type="button"
                  size="sm"
                  variant={s === "RESOLVED" ? "default" : "outline"}
                  disabled={setStatus.isPending}
                  onClick={() =>
                    setStatus.mutate(
                      { id: ticket.id, status: s },
                      { onSuccess: () => toast.success("Ticket updated."), onError: (e) => toast.error(getErrorMessage(e, "Could not update the ticket.")) },
                    )
                  }
                >
                  {ACTION_LABELS[s]}
                </Button>
              ))}
            </div>

            <div className="grid gap-3">
              <h3 className="text-sm font-semibold">Conversation ({ticket.comments.length})</h3>
              {ticket.comments.length === 0 ? <p className="text-sm text-muted-foreground">No replies yet.</p> : null}
              {ticket.comments.map((c) => (
                <div key={c.id} className="rounded-md border p-3 text-sm">
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {c.author.name} <span className="text-xs font-normal text-muted-foreground">{c.author.role}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(c.createdAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{c.body}</p>
                </div>
              ))}
            </div>

            {ticket.status === "CLOSED" ? (
              <p className="text-sm text-muted-foreground">This ticket is closed. Reopen it to reply.</p>
            ) : (
              <div className="grid gap-2">
                <textarea
                  rows={3}
                  maxLength={TICKET_COMMENT_MAX}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Write a reply…"
                  aria-label="Reply"
                  className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <div className="flex justify-end">
                  <Button type="button" size="sm" disabled={addComment.isPending || comment.trim() === ""} onClick={send}>
                    {addComment.isPending ? "Sending…" : "Send reply"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
