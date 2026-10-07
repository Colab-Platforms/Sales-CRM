import type { ReactNode } from "react";

export function DetailField({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </dt>
      <dd className="text-sm font-medium">{children ?? "—"}</dd>
    </div>
  );
}

export function DetailGrid({ children, compact }: { children: ReactNode; compact?: boolean }) {
  // sm:/lg: are viewport breakpoints, not container queries - they activate at desktop viewport width
  // regardless of how narrow the grid's actual column is. `compact` opts a narrow host (the WhatsApp
  // Inbox's ~340px right panel) out of that multi-column squeeze, which otherwise crams "Assigned
  // salesperson"-length labels into ~100px columns.
  return <dl className={compact ? "grid gap-y-3" : "grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3"}>{children}</dl>;
}
