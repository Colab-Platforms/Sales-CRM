import type { ReactNode } from "react";

export function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children ?? "—"}</dd>
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
