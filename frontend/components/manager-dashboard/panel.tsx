import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Flat white card used across the sales dashboards: subtle border + shadow, medium radius. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("overflow-hidden rounded-lg border border-border bg-card shadow-sm", className)}>
      {title || actions ? (
        <header className="flex flex-col bg-gradient-to-r from-blue-50/60 via-transparent to-transparent dark:from-blue-500/10 gap-3 border-b border-border/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold tracking-tight">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn("p-4 sm:p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

/** Segmented control for switching a chart's metric. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full overflow-x-auto rounded-md border border-border bg-muted/50 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "shrink-0 rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors",
            o.value === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
