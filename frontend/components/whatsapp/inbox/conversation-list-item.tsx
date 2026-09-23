import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/order-status";
import { MessageStatusBadge } from "../conversation/message-status-badge";
import type { ConversationSummary } from "@/lib/api-client/types/whatsapp-history.types";

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
          "flex w-full flex-col gap-1 border-b px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50",
          selected && "bg-muted",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate text-sm", conversation.awaitingReply ? "font-semibold" : "font-medium")}>{conversation.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(lastMessage.at)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground">{preview}</span>
          {conversation.awaitingReply ? <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Awaiting your reply" /> : null}
        </div>
        <div className="flex items-center gap-1.5">
          <MessageStatusBadge status={lastMessage.status} />
          <span className="text-xs text-muted-foreground">{conversation.mobile ?? "—"}</span>
        </div>
      </button>
    </li>
  );
}
