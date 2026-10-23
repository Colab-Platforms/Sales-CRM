import type { DayStatus } from "@/lib/api-client/types/attendance.types";
import { DAY_STATUS_LABEL } from "@/lib/attendance-export";
import { cn } from "@/lib/utils";

// Two attendance statuses only - Present (green) and Absent (red) - plus neutral styling for "Not Yet Recorded"
// and days outside the reporting period. Shared by the reports, matrix and calendars.
export const DAY_STATUS_STYLE: Record<DayStatus, string> = {
  PRESENT: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  ABSENT: "bg-red-500/15 text-red-700 dark:text-red-300",
  PENDING: "bg-muted text-muted-foreground",
  NOT_JOINED: "text-muted-foreground/60",
  NOT_TRACKED: "text-muted-foreground/60",
};

export function DayStatusBadge({ status, className }: { status: DayStatus; className?: string }) {
  return (
    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", DAY_STATUS_STYLE[status], className)}>
      {DAY_STATUS_LABEL[status]}
    </span>
  );
}
