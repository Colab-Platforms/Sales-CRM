import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

export function LeadSelectionToolbar({
  count,
  onClear,
  onAssignManager,
  onAssignSalesperson,
  onUpdateStatus,
  onDeletePage,
  onDeleteMatching,
  onDownload,
  downloading,
}: {
  count: number;
  onClear: () => void;
  onAssignManager?: () => void;
  onAssignSalesperson?: () => void;
  onUpdateStatus?: () => void;
  /** Delete only the leads selected on this page (Admin). */
  onDeletePage?: () => void;
  /** Delete every lead matching the current filters, across all pages (Admin). Only offered when all matching leads are selected. */
  onDeleteMatching?: () => void;
  /** Download the selected leads as an Excel file. */
  onDownload?: () => void;
  downloading?: boolean;
}) {
  return (
    <div className="sketch-outline flex flex-wrap items-center justify-between gap-3 border-transparent bg-highlight px-4 py-3 text-highlight-foreground">
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
        {onDownload ? (
          <Button size="sm" variant="outline" onClick={onDownload} disabled={downloading} data-testid="download-leads">
            {downloading ? "Starting…" : "Download Leads"}
          </Button>
        ) : null}
        {onAssignSalesperson ? (
          <Button size="sm" onClick={onAssignSalesperson}>
            Assign Salesperson
          </Button>
        ) : null}
        {onUpdateStatus ? (
          <Button size="sm" variant="outline" onClick={onUpdateStatus}>
            Change Status
          </Button>
        ) : null}
        {onDeletePage ? (
          <Button size="sm" variant="destructive" onClick={onDeletePage} data-testid="delete-page">
            Delete current page data
          </Button>
        ) : null}
        {onDeleteMatching ? (
          <Button size="sm" variant="destructive" onClick={onDeleteMatching} data-testid="delete-matching">
            Delete all selected / full matching data ({count.toLocaleString("en-IN")})
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
