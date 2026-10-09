import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { TICKET_PRIORITY_LABELS, TICKET_PRIORITY_STYLES, TICKET_STATUS_LABELS, TICKET_STATUS_STYLES } from "@/lib/ticket-status";
import type { TicketPriority, TicketStatus } from "@/lib/api-client/types/tickets.types";

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return (
    <Badge variant="outline" className={cn("border-current/20", TICKET_STATUS_STYLES[status])}>
      {TICKET_STATUS_LABELS[status]}
    </Badge>
  );
}

export function TicketPriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <Badge variant="outline" className={cn("border-current/20", TICKET_PRIORITY_STYLES[priority])}>
      {TICKET_PRIORITY_LABELS[priority]}
    </Badge>
  );
}
