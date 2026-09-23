"use client";

import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MessageStatusBadge } from "../conversation/message-status-badge";
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

export function MessageBubble({ message, onSelect }: { message: WhatsAppMessageHistoryItem; onSelect: () => void }) {
  const outbound = message.direction === "OUTBOUND";
  // Real body only - "(template message)" is an honest fallback for the small number of historical
  // rows sent before the send path started persisting the resolved body, never a substitute once a
  // real body exists.
  const bodyText = message.body || (message.template || message.messageType === "TEMPLATE" ? "(template message)" : "—");

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  }

  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      {/* A plain div, not a button: the body can contain a real <a> link, and interactive content
          nested inside a <button> is invalid HTML - role="button" + tabIndex + onKeyDown keep it
          just as keyboard/screen-reader accessible. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
        className={cn(
          "max-w-[75%] cursor-pointer rounded-2xl px-3 py-2 text-left text-sm shadow-sm transition-colors sm:max-w-[65%]",
          outbound
            ? "rounded-br-sm bg-primary text-primary-foreground hover:bg-primary/90"
            : "rounded-bl-sm border bg-card hover:bg-muted/40",
        )}
      >
        {message.template ? (
          <p className={cn("mb-0.5 text-[0.7rem] font-medium opacity-70", outbound ? "text-primary-foreground" : "text-muted-foreground")}>
            Template: {message.template.name}
          </p>
        ) : null}
        <p className="whitespace-pre-wrap break-words">{renderBody(bodyText)}</p>
        <div className="mt-1 flex items-center justify-end gap-1.5">
          <span className={cn("text-[0.7rem]", outbound ? "text-primary-foreground/75" : "text-muted-foreground")}>{bubbleTime(message)}</span>
          {/* Status (Queued/Sent/Delivered/Read/Failed) only applies to an outbound send - reuses the
              exact same WhatsAppMessageStatus + MessageStatusBadge the rest of the app (history list,
              Customer 360) already uses, never a second status vocabulary. An inbound message's only
              status value is RECEIVED, which its own left-aligned bubble style already conveys. */}
          {outbound ? <MessageStatusBadge status={message.status} /> : null}
        </div>
      </div>
    </div>
  );
}
