import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/order-status";
import { MessageStatusBadge } from "../conversation/message-status-badge";
import type { ConversationSummary } from "@/lib/api-client/types/whatsapp-history.types";

const TIME_FORMAT = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit" });

// WhatsApp's own convention: today shows a time, anything older shows a short date - reuses the
// existing formatDate helper rather than inventing a second date-formatting utility.
function listTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  return isToday ? TIME_FORMAT.format(date) : formatDate(iso);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0] + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase();
}

export function ConversationListItem({
  conversation,
  selected,
  onSelect,
}: {
  conversation: ConversationSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const { lastMessage } = conversation;
  const preview =
    lastMessage.body ||
    (lastMessage.templateName ? `Template: ${lastMessage.templateName}` : lastMessage.messageType === "TEMPLATE" ? "(template message)" : "—");

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected}
        className={cn(
          "flex w-full items-center gap-3 border-b px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50",
          selected && "bg-muted",
        )}
      >
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
            selected ? "bg-primary text-primary-foreground" : "bg-muted-foreground/15 text-muted-foreground",
          )}
          aria-hidden="true"
        >
          {initials(conversation.name)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn("truncate text-sm", conversation.awaitingReply ? "font-semibold" : "font-medium")}>{conversation.name}</span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide",
                  conversation.mode === "AI" ? "bg-violet-500/15 text-violet-600 dark:text-violet-400" : "bg-muted text-muted-foreground",
                )}
                title={conversation.mode === "AI" ? "AI is handling this conversation" : "A human is handling this conversation"}
              >
                {conversation.mode}
              </span>
            </span>
            <span className="shrink-0 text-[0.7rem] text-muted-foreground">{listTimestamp(lastMessage.at)}</span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className={cn("truncate text-xs", conversation.awaitingReply ? "font-medium text-foreground" : "text-muted-foreground")}>{preview}</span>
            {conversation.unreadCount > 0 ? (
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-[0.65rem] font-semibold text-primary-foreground" role="status" aria-label={`${conversation.unreadCount} unread`}>
                {conversation.unreadCount > 9 ? "9+" : conversation.unreadCount}
              </span>
            ) : conversation.awaitingReply ? (
              <span className="flex size-2 shrink-0 rounded-full bg-primary" role="status" aria-label="Awaiting your reply" />
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <MessageStatusBadge status={lastMessage.status} />
            <span className="truncate text-xs text-muted-foreground">{conversation.mobile ?? "—"}</span>
            {conversation.assignedTo ? <span className="truncate text-xs text-muted-foreground">· {conversation.assignedTo.name}</span> : null}
          </div>
        </div>
      </button>
    </li>
  );
}
