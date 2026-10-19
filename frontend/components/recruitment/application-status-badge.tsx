import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ApplicationStatus } from "@/lib/api-client/types/recruitment.types";

// One color per status, shared by the badge, the inline status select and the detail page banner.
const STATUS_STYLES: Record<ApplicationStatus, string> = {
  NEW: "border-slate-400/60 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  ASSIGNED: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  SCREENED: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  SHORTLISTED: "border-amber-500/50 bg-amber-500/15 text-amber-800 dark:text-amber-300",
  HIRED: "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  REJECTED: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  // Legacy call-based statuses: no longer set from the UI, but old rows may still carry them.
  RINGING: "border-slate-400/60 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  NOT_REACHABLE: "border-slate-400/60 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  CALL_BACK: "border-slate-400/60 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  NOT_INTERESTED: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
};

export function applicationStatusClasses(status: ApplicationStatus): string {
  return STATUS_STYLES[status];
}

export function applicationStatusLabel(status: ApplicationStatus): string {
  const text = status.replaceAll("_", " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function ApplicationStatusBadge({ status, className }: { status: ApplicationStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn(STATUS_STYLES[status], className)}>
      {applicationStatusLabel(status)}
    </Badge>
  );
}
