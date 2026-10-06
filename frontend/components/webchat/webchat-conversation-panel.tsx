"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect } from "@/components/ui/native-select";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { adminSalespersonsQueryOptions } from "@/lib/api-client/queries/admin.queries";
import { mySalespersonsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { webChatDetailQueryOptions } from "@/lib/api-client/queries/webchat.queries";
import {
  useWebChatArchiveMutation,
  useWebChatAssignMutation,
  useWebChatHandoffMutation,
  useWebChatMarkReadMutation,
  useWebChatReturnToAiMutation,
  useWebChatSendMessageMutation,
} from "@/lib/api-client/mutations/webchat.mutations";
import type { WebChatConversationDetail, WebChatMessageItem } from "@/lib/api-client/types/webchat.types";
import { leadDetailHref } from "@/components/leads/lead-table";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import { displayName, isUnread } from "./webchat-helpers";

const DATE_TIME = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

const SENDER_LABELS: Record<WebChatMessageItem["sender"], string> = {
  CUSTOMER: "Customer",
  AI: "AI",
  AGENT: "Agent",
};

function MessageBubble({ message }: { message: WebChatMessageItem }) {
  const isAgent = message.sender === "AGENT";
  const isCustomer = message.sender === "CUSTOMER";
  return (
    <div className={cn("flex", isAgent ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2 text-sm",
          isAgent ? "bg-primary text-primary-foreground" : isCustomer ? "bg-muted" : "border bg-card",
        )}
      >
        <div className={cn("mb-0.5 text-[11px] font-medium", isAgent ? "text-primary-foreground/80" : "text-muted-foreground")}>
          {SENDER_LABELS[message.sender]}
          {isAgent && message.sentBy ? ` · ${message.sentBy.name}` : ""}
        </div>
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        <div className={cn("mt-1 text-right text-[10px]", isAgent ? "text-primary-foreground/70" : "text-muted-foreground")}>
          {DATE_TIME.format(new Date(message.createdAt))}
        </div>
      </div>
    </div>
  );
}

function InfoPanel({ detail }: { detail: WebChatConversationDetail }) {
  const lead = detail.lead;
  return (
    <div className="space-y-4 p-4 text-sm">
      <div>
        <h3 className="mb-2 font-medium">Customer</h3>
        {lead ? (
          <div className="space-y-1">
            <Link href={leadDetailHref(lead.id)} className="font-medium text-primary hover:underline">
              Open Lead {lead.leadNumber}
            </Link>
            <p className="text-muted-foreground">{lead.mobile ?? "No phone on file"}</p>
            <p className="text-muted-foreground">{lead.email ?? "No email on file"}</p>
          </div>
        ) : (
          <p className="text-muted-foreground">Anonymous Visitor - no Lead yet. A Lead is created only once this visitor shares their contact details.</p>
        )}
      </div>
      <dl className="space-y-2">
        <div>
          <dt className="text-xs text-muted-foreground">Mode</dt>
          <dd className="font-medium">{detail.mode === "HUMAN" ? "Human" : "AI"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Assigned salesperson</dt>
          <dd>{detail.assignedTo?.name ?? "Unassigned"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Intent</dt>
          <dd>{detail.intent ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Product interest</dt>
          <dd>{detail.productInterest ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Started</dt>
          <dd>{DATE_TIME.format(new Date(detail.createdAt))}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last message</dt>
          <dd>{detail.lastMessageAt ? DATE_TIME.format(new Date(detail.lastMessageAt)) : "—"}</dd>
        </div>
      </dl>
    </div>
  );
}

export function WebChatConversationPanel({
  conversationId,
  onBack,
  onClosed,
}: {
  conversationId: string;
  onBack: () => void;
  onClosed: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const role = user?.role;
  const detail = useQuery({ ...webChatDetailQueryOptions(conversationId), enabled: Boolean(user) });
  const data = detail.data;

  const { mutate: markAsRead } = useWebChatMarkReadMutation();
  const { mutate: assign, isPending: assigning } = useWebChatAssignMutation();
  const { mutate: handoff, isPending: handingOff } = useWebChatHandoffMutation();
  const { mutate: returnToAi, isPending: returningToAi } = useWebChatReturnToAiMutation();
  const { mutate: archive, isPending: archiving } = useWebChatArchiveMutation();
  const { mutate: sendMessage, isPending: sending } = useWebChatSendMessageMutation();

  const [draft, setDraft] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const readKeyRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Opening a conversation marks it read. The key guards against re-marking the same message
  // again; a new customer message changes lastMessageAt, which produces a new key and marks it once more.
  useEffect(() => {
    if (!data || !isUnread(data)) return;
    const key = `${data.id}:${data.lastMessageAt}`;
    if (readKeyRef.current === key) return;
    readKeyRef.current = key;
    markAsRead(data.id);
  }, [data, markAsRead]);

  const messageCount = data?.messages.length ?? 0;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messageCount, conversationId]);

  // Reassign list: ADMIN sees every salesperson, MANAGER their own team. SALESPERSON gets only
  // "assign to me" - the backend enforces the same rule regardless of what the UI offers.
  const adminAgents = useQuery({ ...adminSalespersonsQueryOptions(), enabled: role === "ADMIN" });
  const managerAgents = useQuery({ ...mySalespersonsQueryOptions(), enabled: role === "MANAGER" });
  const reassignOptions = role === "ADMIN" ? adminAgents.data : role === "MANAGER" ? managerAgents.data : undefined;

  if (detail.isPending || !data) {
    if (detail.isError) {
      return (
        <div className="space-y-3 p-6">
          <Button variant="ghost" size="sm" onClick={onBack} className="md:hidden">
            <ArrowLeft /> Back
          </Button>
          <p role="alert" className="text-sm text-destructive">
            {getErrorMessage(detail.error, "Failed to load this chat.")}
          </p>
        </div>
      );
    }
    return (
      <div className="space-y-3 p-6" aria-busy="true" aria-label="Loading chat">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const isAssignedToMe = data.assignedTo?.id === user?.id;
  const isHuman = data.mode === "HUMAN";
  const isArchived = Boolean(data.archivedAt);
  const modeChanging = handingOff || returningToAi;

  function onAssignMe() {
    if (!user) return;
    assign(
      { id: data!.id, assignedToId: user.id },
      { onSuccess: () => toast.success("Chat assigned to you."), onError: (e) => toast.error(getErrorMessage(e, "Could not assign this chat.")) },
    );
  }

  function onReassign(assignedToId: string) {
    assign(
      { id: data!.id, assignedToId },
      { onSuccess: () => toast.success("Chat reassigned."), onError: (e) => toast.error(getErrorMessage(e, "Could not reassign this chat.")) },
    );
  }

  function onSend() {
    const text = draft.trim();
    if (!text || sending) return;
    sendMessage(
      { id: data!.id, text },
      {
        onSuccess: () => {
          setDraft("");
          toast.success("Reply saved. Delivery to the visitor is not connected yet.");
        },
        onError: (e) => toast.error(getErrorMessage(e, "Could not save your reply.")),
      },
    );
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  function onConfirmArchive() {
    archive(data!.id, {
      onSuccess: () => {
        toast.success("Chat archived. Its history was kept.");
        setArchiveOpen(false);
        onClosed();
      },
      onError: (e) => toast.error(getErrorMessage(e, "Could not archive this chat.")),
    });
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onBack} aria-label="Back to chats">
              <ArrowLeft />
            </Button>
            <div className="min-w-0">
              <p className="truncate font-semibold">{displayName(data)}</p>
              <p className="truncate text-xs text-muted-foreground">
                {data.lead?.mobile ?? data.lead?.email ?? "No contact details yet"}
                {" · "}
                <span className="font-medium text-foreground">{isHuman ? "Human" : "AI"}</span>
                {isArchived ? " · Archived" : ""}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!isAssignedToMe ? (
              <Button size="sm" variant="outline" onClick={onAssignMe} disabled={assigning || !user || isArchived}>
                Assign to me
              </Button>
            ) : null}
            {reassignOptions ? (
              <NativeSelect
                aria-label="Reassign to salesperson"
                className="h-8 w-44"
                value={data.assignedTo?.id ?? ""}
                disabled={assigning || isArchived}
                onChange={(e) => {
                  if (e.target.value) onReassign(e.target.value);
                }}
              >
                <option value="" disabled>
                  {data.assignedTo ? "Reassign…" : "Assign…"}
                </option>
                {reassignOptions.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
            {isHuman ? (
              <Button size="sm" variant="outline" onClick={() => returnToAi(data.id, { onError: (e) => toast.error(getErrorMessage(e, "Could not return this chat to AI.")) })} disabled={modeChanging || isArchived}>
                Return to AI
              </Button>
            ) : (
              <Button size="sm" onClick={() => handoff(data.id, { onError: (e) => toast.error(getErrorMessage(e, "Could not hand this chat to a human.")) })} disabled={modeChanging || isArchived}>
                Hand off to human
              </Button>
            )}
            {!isArchived ? (
              <Button size="sm" variant="outline" onClick={() => setArchiveOpen(true)} disabled={archiving}>
                Archive
              </Button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {data.messages.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No messages yet.</p>
          ) : (
            data.messages.map((message) => <MessageBubble key={message.id} message={message} />)
          )}
          <div ref={bottomRef} />
        </div>

        <div className="space-y-2 border-t p-3">
          <p className="text-xs text-muted-foreground">
            Replies are saved in the CRM. The website visitor does not receive them yet.
          </p>
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKeyDown}
              disabled={sending || isArchived}
              rows={2}
              maxLength={4000}
              placeholder={isArchived ? "This chat is archived." : "Type a reply. Enter to send, Shift+Enter for a new line."}
              aria-label="Reply"
              className="min-h-10 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
            <Button onClick={onSend} disabled={sending || isArchived || !draft.trim()} aria-label="Send reply">
              <Send />
              {sending ? "Saving…" : "Send"}
            </Button>
          </div>
        </div>
      </div>

      <div className="hidden min-h-0 w-[300px] shrink-0 overflow-y-auto border-l lg:block">
        <InfoPanel detail={data} />
      </div>

      <ConfirmActionDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive this chat?"
        description="It leaves the active queue and moves to Archived. Its messages and history are kept."
        confirmLabel="Archive"
        pendingLabel="Archiving…"
        pending={archiving}
        onConfirm={onConfirmArchive}
      />
    </div>
  );
}
