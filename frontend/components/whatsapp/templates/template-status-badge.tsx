import { Badge } from "@/components/ui/badge";
import { TEMPLATE_STATUS_COLORS, TEMPLATE_STATUS_LABELS } from "@/lib/whatsapp-template-status";
import type { WhatsAppTemplateStatus } from "@/lib/api-client/types/whatsapp-templates.types";

export function TemplateStatusBadge({ status }: { status: WhatsAppTemplateStatus }) {
  return <Badge className={TEMPLATE_STATUS_COLORS[status]}>{TEMPLATE_STATUS_LABELS[status]}</Badge>;
}
