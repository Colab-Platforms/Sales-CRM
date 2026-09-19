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
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/50 px-4 py-2.5">
      <span className="text-sm font-medium">
        {count} lead{count === 1 ? "" : "s"} selected
      </span>
      <div className="flex items-center gap-2">
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
        <Button size="sm" variant="ghost" onClick={onClear} className="gap-1">
          <X className="size-3.5" />
          Clear
        </Button>
      </div>
    </div>
  );
}
