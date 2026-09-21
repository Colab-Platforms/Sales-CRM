import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

export function LeadSelectionToolbar({
  count,
  onClear,
  onAssignManager,
  onAssignSalesperson,
}: {
  count: number;
  onClear: () => void;
  onAssignManager?: () => void;
  onAssignSalesperson?: () => void;
}) {
  return (
    <div className="sketch-outline flex flex-wrap items-center justify-between gap-3 border-primary/40 bg-primary/8 px-4 py-3">
      <span className="flex items-center gap-2 text-sm">
        <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground tabular-nums">
          {count}
        </span>
        <span className="font-semibold">lead{count === 1 ? "" : "s"} selected</span>
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {onAssignManager ? (
          <Button size="sm" onClick={onAssignManager}>
            Assign Manager
          </Button>
        ) : null}
        {onAssignSalesperson ? (
          <Button size="sm" onClick={onAssignSalesperson}>
            Assign Salesperson
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onClear}>
          <X />
          Clear
        </Button>
      </div>
    </div>
  );
}
