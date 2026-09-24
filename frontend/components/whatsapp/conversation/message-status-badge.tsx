import { Badge } from "@/components/ui/badge";
import { MESSAGE_STATUS_COLORS, MESSAGE_STATUS_LABELS } from "@/lib/whatsapp-message-status";
import type { WhatsAppMessageStatus } from "@/lib/api-client/types/whatsapp-history.types";

export function MessageStatusBadge({ status }: { status: WhatsAppMessageStatus }) {
  return <Badge className={MESSAGE_STATUS_COLORS[status]}>{MESSAGE_STATUS_LABELS[status]}</Badge>;
}
