import { Badge } from "@/components/ui/badge";
import { ACTIVITY_SOURCE_LABELS } from "@/lib/audit-status";
import type { ActivitySource } from "@/lib/api-client/types/audit.types";

// Neutral styling on purpose: the source is informational context, not a status to flag.
export function AuditSourceBadge({ source }: { source: ActivitySource }) {
  return <Badge variant="secondary">{ACTIVITY_SOURCE_LABELS[source]}</Badge>;
}
