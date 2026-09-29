import { Badge } from "@/components/ui/badge";
import { TEMPLATE_STATUS_COLORS, templateStatusLabel } from "@/lib/whatsapp-template-status";
import type { WhatsAppTemplateStatus } from "@/lib/api-client/types/whatsapp-templates.types";

export function TemplateStatusBadge({ status, provider }: { status: WhatsAppTemplateStatus; provider?: string }) {
  return <Badge className={TEMPLATE_STATUS_COLORS[status]}>{templateStatusLabel(provider ?? "", status)}</Badge>;
}
