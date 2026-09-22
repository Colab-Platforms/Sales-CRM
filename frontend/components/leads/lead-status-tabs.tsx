"use client";

import { cn } from "@/lib/utils";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";

/**
 * "ALL" clears the workingStatus filter. CALLBACK_DUE/FOLLOWUP_DUE aren't
 * backed by a lead-level field or query yet (that lives on Task, which the
 * lead list endpoint doesn't join), so they're disabled placeholders rather
 * than a filter that silently returns nothing.
 */
export type LeadStatusTab = "ALL" | LeadWorkingStatus | "CALLBACK_DUE" | "FOLLOWUP_DUE";

interface TabDef {
  id: LeadStatusTab;
  label: string;
  disabled?: boolean;
}

const TABS: TabDef[] = [
  { id: "ALL", label: "All Leads" },
  { id: "NEW", label: "Fresh" },
  { id: "WORKING", label: "Working" },
  { id: "INTERESTED", label: "Interested" },
  { id: "CALLBACK_DUE", label: "Callback Due", disabled: true },
  { id: "FOLLOWUP_DUE", label: "Follow-up Due", disabled: true },
  { id: "CLOSED", label: "Closed" },
];

export function LeadStatusTabs({
  active,
  onChange,
}: {
  active: LeadStatusTab;
  onChange: (tab: LeadStatusTab) => void;
}) {
  return (
    <div role="tablist" aria-label="Filter leads by status" className="flex flex-wrap gap-2">
      {TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={tab.disabled}
            title={tab.disabled ? `${tab.label} — coming soon` : undefined}
            onClick={() => onChange(tab.id)}
            className={cn(
              "sketch-press inline-flex h-8 items-center gap-1.5 rounded-[10px_8px_11px_8px] border-[1.5px] px-3 text-[0.8rem] font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none",
              isActive
                ? "border-ink-line bg-primary text-primary-foreground"
                : "border-ink-line/50 bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
              tab.disabled && "opacity-50",
            )}
          >
            {tab.label}
            {tab.disabled ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.6rem] font-bold tracking-wide text-muted-foreground uppercase">
                Soon
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
