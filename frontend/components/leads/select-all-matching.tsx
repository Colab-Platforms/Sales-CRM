import { Button } from "@/components/ui/button";

/** Shown when every lead on the page is selected but more leads match the filter: offers to select them all (e.g. a whole 56,000-lead segment) without loading them. */
export function SelectAllMatching({ pageCount, total, allSelected, onSelectAll, onClear }: { pageCount: number; total: number; allSelected: boolean; onSelectAll: () => void; onClear: () => void }) {
  if (total <= pageCount) return null;
  return (
    <div className="sketch-outline flex flex-wrap items-center gap-3 bg-muted/50 px-4 py-2.5 text-sm" data-testid="select-all-matching">
      {allSelected ? (
        <>
          <span>
            All <strong className="tabular-nums">{total.toLocaleString("en-IN")}</strong> leads matching this filter are selected.
          </span>
          <Button size="sm" variant="ghost" type="button" onClick={onClear}>
            Clear selection
          </Button>
        </>
      ) : (
        <>
          <span>
            All <strong className="tabular-nums">{pageCount}</strong> leads on this page are selected.
          </span>
          <Button size="sm" variant="outline" type="button" onClick={onSelectAll}>
            Select all {total.toLocaleString("en-IN")} leads matching this filter
          </Button>
        </>
      )}
    </div>
  );
}
