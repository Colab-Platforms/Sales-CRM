import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ACTIVITY_TYPE_COLORS, ACTIVITY_TYPE_LABELS } from "@/lib/audit-status";
import type { ActivityType } from "@/lib/api-client/types/audit.types";

export function ActivityTypeBadge({ type }: { type: ActivityType }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", ACTIVITY_TYPE_COLORS[type])}>
      {ACTIVITY_TYPE_LABELS[type]}
    </Badge>
  );
}
