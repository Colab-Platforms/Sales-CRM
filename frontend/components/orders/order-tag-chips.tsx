"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const CONFIRMATION = /^CRM Confirmed by\b/i;
const MAX_VISIBLE = 2;

/** Splits a tag list into what the cell shows and what hides behind "+N". Pure, so the rule is testable. */
export function splitTags(tags: readonly string[], max: number = MAX_VISIBLE): { visible: string[]; hidden: string[] } {
  return { visible: tags.slice(0, max), hidden: tags.slice(max) };
}

function Chip({ tag, className }: { tag: string; className?: string }) {
  return (
    <span
      title={tag}
      className={cn(
        "inline-flex max-w-[11rem] items-center truncate rounded-md border px-1.5 py-0.5 text-[11px] leading-tight font-medium",
        CONFIRMATION.test(tag) ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-border bg-muted/60 text-foreground",
        className,
      )}
    >
      {tag}
    </span>
  );
}

// Compact tag chips for an Orders row: the first few, then "+N" that opens the complete list. No tags -> an em dash.
export function OrderTagChips({ tags }: { tags?: readonly string[] | null }) {
  const all = tags ?? [];
  if (all.length === 0) return <span className="text-muted-foreground">—</span>;
  const { visible, hidden } = splitTags(all);
  return (
    <div className="flex max-w-[15rem] flex-wrap items-center gap-1" data-testid="order-tags">
      {visible.map((t) => (
        <Chip key={t} tag={t} />
      ))}
      {hidden.length > 0 ? (
        // stopPropagation: the table row itself navigates on click.
        <span onClick={(e) => e.stopPropagation()}>
          <Popover>
            <PopoverTrigger
              aria-label={`Show all ${all.length} tags`}
              title={all.join(", ")}
              className="inline-flex items-center rounded-md border border-dashed px-1.5 py-0.5 text-[11px] leading-tight font-medium text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              +{hidden.length}
            </PopoverTrigger>
            <PopoverContent>
              <div className="grid max-w-72 gap-1.5 font-normal normal-case">
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tags ({all.length})</p>
                <div className="flex flex-wrap gap-1">
                  {all.map((t) => (
                    <Chip key={t} tag={t} className="max-w-full" />
                  ))}
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </span>
      ) : null}
    </div>
  );
}
