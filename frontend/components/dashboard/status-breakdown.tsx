import { STATUS_ORDER, STATUS_LABELS, STATUS_FILLS } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { StatusCounts } from "@/lib/api-client/types/dashboard.types";

/**
 * Proportional meter plus a labelled legend. Every segment is also named and
 * counted in text below, so identity never rests on colour alone — which the
 * lighter fills need, since they sit under 3:1 against the card surface.
 */
export function StatusBreakdown({ counts }: { counts: StatusCounts }) {
  const total = STATUS_ORDER.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
  const present = STATUS_ORDER.filter((status) => (counts[status] ?? 0) > 0);

  const share = (status: (typeof STATUS_ORDER)[number]) =>
    total === 0 ? 0 : Math.round(((counts[status] ?? 0) / total) * 100);

  return (
    <div className="space-y-5">
      {total === 0 ? (
        <div className="sketch-dashed flex h-3.5 items-center justify-center" />
      ) : (
        <div className="flex h-3.5 gap-0.5" role="img" aria-label="Lead status distribution">
          {present.map((status) => (
            <div
              key={status}
              title={`${STATUS_LABELS[status]}: ${counts[status]} (${share(status)}%)`}
              style={{ flexGrow: counts[status], flexBasis: 0 }}
              className={cn("min-w-0.75 rounded-[3px]", STATUS_FILLS[status])}
            />
          ))}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        {STATUS_ORDER.map((status) => {
          const count = counts[status] ?? 0;
          return (
            <div
              key={status}
              className={cn(
                "flex items-center gap-2.5",
                count === 0 && "opacity-45"
              )}
            >
              <span
                aria-hidden="true"
                className={cn("size-2.5 shrink-0 rounded-[3px]", STATUS_FILLS[status])}
              />
              <div className="min-w-0">
                <dt className="truncate text-xs font-medium text-muted-foreground">
                  {STATUS_LABELS[status]}
                </dt>
                <dd className="flex items-baseline gap-1.5">
                  <span className="text-base leading-tight font-bold tabular-nums">{count}</span>
                  <span className="font-hand text-sm text-muted-foreground">
                    {share(status)}%
                  </span>
                </dd>
              </div>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
