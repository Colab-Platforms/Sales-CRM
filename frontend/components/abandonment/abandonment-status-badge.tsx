import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AbandonmentStatus, RecoveryActionType } from "@/lib/api-client/types/abandonment.types";

export const ABANDONMENT_STATUS_LABELS: Record<AbandonmentStatus, string> = {
  ACTIVE: "Not yet contacted",
  IN_PROGRESS: "Being worked",
  RECOVERED: "Recovered",
  NOT_RECOVERED: "Not recovered",
  EXPIRED: "Expired",
};

export const ABANDONMENT_STATUS_COLORS: Record<AbandonmentStatus, string> = {
  ACTIVE: "bg-red-500/10 text-red-600 dark:text-red-400",
  IN_PROGRESS: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  RECOVERED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  NOT_RECOVERED: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  EXPIRED: "bg-slate-500/10 text-slate-500 dark:text-slate-400",
};

export function AbandonmentStatusBadge({ status }: { status: AbandonmentStatus }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", ABANDONMENT_STATUS_COLORS[status])}>
      {ABANDONMENT_STATUS_LABELS[status]}
    </Badge>
  );
}

export const RECOVERY_ACTION_TYPE_LABELS: Record<RecoveryActionType, string> = {
  CALL: "Call",
  CALLBACK: "Callback",
  CONTINUE_ORDER: "Continued order",
};
