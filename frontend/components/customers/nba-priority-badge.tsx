import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { NBA_PRIORITY_COLORS, NBA_PRIORITY_LABELS } from "@/lib/nba-status";
import type { NbaPriority } from "@/lib/api-client/types/customers.types";

export function NbaPriorityBadge({ priority }: { priority: NbaPriority }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", NBA_PRIORITY_COLORS[priority])}>
      {NBA_PRIORITY_LABELS[priority]}
    </Badge>
  );
}
