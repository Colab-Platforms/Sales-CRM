"use client";

import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { toast } from "sonner";
import { Check, MoreVertical, PenLine, Reply as ReplyIcon, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MessageStatusBadge } from "../conversation/message-status-badge";
import { useStarMessageMutation, useUnstarMessageMutation } from "@/lib/api-client/mutations/whatsapp-history.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import type { WhatsAppMessageHistoryItem } from "@/lib/api-client/types/whatsapp-history.types";

const TIME_FORMAT = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit" });
// One capturing group so String.split keeps the matched URLs in the result, interleaved with the
// surrounding plain text - never dangerouslySetInnerHTML, just an ordinary array of text/anchor nodes.
const URL_PATTERN = /(https?:\/\/[^\s<>"')]+)/g;

function bubbleTime(message: WhatsAppMessageHistoryItem): string {
  const at = message.direction === "OUTBOUND" ? (message.sentAt ?? message.createdAt) : (message.receivedAt ?? message.createdAt);
  return at ? TIME_FORMAT.format(new Date(at)) : "";
}

// Renders the real stored body as-is (never fabricated), preserving line breaks via the container's
// whitespace-pre-wrap, with any http(s) URL turned into a safe, clickable link. stopPropagation on
// the link keeps a tap on it from also opening the message-detail dialog underneath.
function renderBody(text: string): ReactNode[] {
  return text.split(URL_PATTERN).map((part, i) =>
    i % 2 === 1 ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:opacity-80"
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export function MessageBubble({
  message,
  onSelect,
  replyTo,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onReply,
  onCorrect,
  onForward,
  onDeleteForMe,
}: {
  message: WhatsAppMessageHistoryItem;
  onSelect: () => void;
  /** The real message this one is a provider-reported reply to (Meta's context.id, resolved by the
   *  caller against the currently loaded messages) - only ever real, already-fetched data, never a
   *  fabricated relationship. Undefined when this message has no reply reference, or the referenced
   *  message isn't in the currently loaded window. */
  replyTo?: WhatsAppMessageHistoryItem;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onReply?: (message: WhatsAppMessageHistoryItem) => void;
  /** "Correct Message": opens the same quoted-reply composer as Reply, pre-filled with a correction
   *  sentence the telecaller can edit - a real outbound reply through the existing send pipeline,
   *  never an edit/delete of this message itself (Meta's Cloud API has no edit/recall capability). */
  onCorrect?: (message: WhatsAppMessageHistoryItem) => void;
  onForward?: (message: WhatsAppMessageHistoryItem) => void;
  onDeleteForMe?: (message: WhatsAppMessageHistoryItem) => void;
}) {
  const outbound = message.direction === "OUTBOUND";
  const star = useStarMessageMutation();
  const unstar = useUnstarMessageMutation();
  // Real body only - "(template message)" is an honest fallback for the small number of historical
  // rows sent before the send path started persisting the resolved body, never a substitute once a
  // real body exists.
  const bodyText = message.body || (message.template || message.messageType === "TEMPLATE" ? "(template message)" : "—");
  const replyToText = replyTo ? replyTo.body || (replyTo.template ? `Template: ${replyTo.template.name}` : "(message)") : null;
  // Only a real TEXT message has a stored body to copy or re-send - the CRM never stores media
  // content for image/video/document/audio messages (only that one happened), so Copy/Forward would
  // either show nothing or silently fabricate an attachment. Hidden, not shown-then-failing.
  const isTextWithBody = message.messageType === "TEXT" && Boolean(message.body);
  // "Correct Message" only makes sense for a message the telecaller/CRM itself sent (outbound), with a
  // real stored body to quote and a real providerMessageId to reply against through the existing
  // context.message_id mechanism - the same eligibility the backend's sendConversationText already
  // enforces for any replyToMessageId. Never shown for inbound (customer) messages or ones with
  // nothing real to quote.
  const canCorrect = outbound && isTextWithBody && Boolean(message.providerMessageId);

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (selectionMode) onToggleSelect?.();
      else onSelect();
    }
  }

  function handleClick() {
    if (selectionMode) onToggleSelect?.();
    else onSelect();
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message.body ?? "");
      toast.success("Copied.");
    } catch {
      toast.error("Could not copy - your browser blocked clipboard access.");
    }
  }

  function toggleStar(e: MouseEvent) {
    e.stopPropagation();
    if (message.starred) unstar.mutate(message.id, { onError: (err) => toast.error(getErrorMessage(err, "Could not unstar the message.")) });
    else star.mutate(message.id, { onError: (err) => toast.error(getErrorMessage(err, "Could not star the message.")) });
  }

  return (
    <div className={cn("group flex items-start gap-2", outbound ? "justify-end" : "justify-start")}>
      {selectionMode ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleSelect?.(); }}
          aria-label={selected ? "Deselect message" : "Select message"}
          className={cn(
            "mt-2.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
            selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
          )}
        >
          {selected ? <Check className="size-3" /> : null}
        </button>
      ) : null}

      <div className={cn("flex max-w-[75%] items-center gap-1 sm:max-w-[65%]", outbound ? "flex-row-reverse" : "flex-row")}>
        {/* A plain div, not a button: the body can contain a real <a> link, and interactive content
            nested inside a <button> is invalid HTML - role="button" + tabIndex + onKeyDown keep it
            just as keyboard/screen-reader accessible. */}
        <div
          role="button"
          tabIndex={0}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          className={cn(
            "cursor-pointer rounded-2xl px-3 py-2 text-left text-sm shadow-sm transition-colors",
            outbound
              ? "rounded-br-sm bg-primary text-primary-foreground hover:bg-primary/90"
              : "rounded-bl-sm border bg-card hover:bg-muted/40",
          )}
        >
          {replyToText ? (
            // Real, provider-confirmed reply reference only (Meta's context.id) - a quoted-preview
            // strip, the same visual idea WhatsApp itself uses for a reply, never a guessed link.
            <div
              className={cn(
                "mb-1 rounded-md border-l-2 px-2 py-1 text-xs opacity-80",
                outbound ? "border-primary-foreground/50 bg-primary-foreground/10" : "border-primary/50 bg-muted/60",
              )}
            >
              <p className="line-clamp-2 whitespace-pre-wrap break-words">{replyToText}</p>
            </div>
          ) : null}
          {message.template ? (
            <p className={cn("mb-0.5 text-[0.7rem] font-medium opacity-70", outbound ? "text-primary-foreground" : "text-muted-foreground")}>
              Template: {message.template.name}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap break-words">{renderBody(bodyText)}</p>
          <div className="mt-1 flex items-center justify-end gap-1.5">
            {message.starred ? <Star className="size-3 fill-current opacity-80" aria-label="Starred" /> : null}
            <span className={cn("text-[0.7rem]", outbound ? "text-primary-foreground/75" : "text-muted-foreground")}>{bubbleTime(message)}</span>
            {/* Status (Queued/Sent/Delivered/Read/Failed) only applies to an outbound send - reuses the
                exact same WhatsAppMessageStatus + MessageStatusBadge the rest of the app (history list,
                Customer 360) already uses, never a second status vocabulary. An inbound message's only
                status value is RECEIVED, which its own left-aligned bubble style already conveys. */}
            {outbound ? <MessageStatusBadge status={message.status} /> : null}
          </div>
        </div>

        {!selectionMode ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[popup-open]:opacity-100"
                  aria-label="Message actions"
                  onClick={(e: MouseEvent) => e.stopPropagation()}
                />
              }
            >
              <MoreVertical className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align={outbound ? "end" : "start"}>
              <DropdownMenuItem onClick={() => onReply?.(message)} className="gap-2">
                <ReplyIcon className="size-4" />
                Reply
              </DropdownMenuItem>
              {canCorrect ? (
                <DropdownMenuItem onClick={() => onCorrect?.(message)} className="gap-2">
                  <PenLine className="size-4" />
                  Correct Message
                </DropdownMenuItem>
              ) : null}
              {isTextWithBody ? (
                <DropdownMenuItem onClick={handleCopy} className="gap-2">
                  Copy
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={toggleStar} className="gap-2">
                {message.starred ? "Unstar" : "Star"}
              </DropdownMenuItem>
              {isTextWithBody ? (
                <DropdownMenuItem onClick={() => onForward?.(message)} className="gap-2">
                  Forward
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled title="Only text messages can be forwarded - the CRM does not store the original media." className="gap-2">
                  Forward
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onToggleSelect?.()} className="gap-2">
                Select
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* Only "Delete for me" exists - no WhatsApp provider configured here (Meta/AiSensy/Gupshup)
                  exposes a real delete-for-everyone/recall API (see whatsapp.message-actions.service.ts's
                  header comment for the full finding). Deliberately not shown even disabled, since that
                  would imply the capability is close to existing rather than simply absent from the API. */}
              <DropdownMenuItem onClick={() => onDeleteForMe?.(message)} variant="destructive" className="gap-2">
                Delete for me
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
