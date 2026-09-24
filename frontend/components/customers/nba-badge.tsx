import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { NBA_ACTION_COLORS, NBA_ACTION_LABELS } from "@/lib/nba-status";
import type { NbaAction } from "@/lib/api-client/types/customers.types";

export function NbaBadge({ action }: { action: NbaAction }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", NBA_ACTION_COLORS[action])}>
      {NBA_ACTION_LABELS[action]}
    </Badge>
  );
}
