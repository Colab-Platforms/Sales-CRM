"use client";

import { cn } from "@/lib/utils";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";

/** "ALL" clears the workingStatus filter; every other tab filters on one LeadWorkingStatus. */
export type LeadStatusTab = "ALL" | LeadWorkingStatus;

interface TabDef {
  id: LeadStatusTab;
  label: string;
}

const TABS: TabDef[] = [
  { id: "ALL", label: "All Leads" },
  { id: "NEW", label: "Fresh" },
  { id: "RINGING", label: "Ringing" },
  { id: "BUSY", label: "Busy" },
  { id: "CALL_BACK", label: "Call Back" },
  { id: "FOLLOW_UP", label: "Follow Up" },
  { id: "SWITCHED_OFF", label: "Switched Off" },
  { id: "DND", label: "DND" },
  { id: "NOT_REACHABLE", label: "Not Reachable" },
  { id: "INTERESTED", label: "Interested" },
  { id: "NOT_INTERESTED", label: "Not Interested" },
  { id: "CONVERTED", label: "Converted" },
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
            onClick={() => onChange(tab.id)}
            className={cn(
              "sketch-press inline-flex h-8 items-center gap-1.5 rounded-[10px_8px_11px_8px] border-[1.5px] px-3 text-[0.8rem] font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              isActive
                ? "border-ink-line bg-primary text-primary-foreground"
                : "border-ink-line/50 bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
