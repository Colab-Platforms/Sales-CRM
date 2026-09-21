import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

const TONES = {
  default: "border-ink-line/25 bg-muted text-muted-foreground",
  primary: "border-primary/35 bg-primary/10 text-primary",
  teal: "border-teal-500/35 bg-teal-500/10 text-teal-600 dark:text-teal-300",
  amber: "border-amber-500/40 bg-amber-500/12 text-amber-600 dark:text-amber-300",
  emerald: "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
} as const;

export type StatTone = keyof typeof TONES;

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  className,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  tone?: StatTone;
  className?: string;
}) {
  return (
    <Card className={cn("transition-transform hover:-translate-y-0.5", className)}>
      <CardContent className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
            {label}
          </p>
          <p className="font-heading text-3xl leading-none font-extrabold tabular-nums">
            {value}
          </p>
          {hint ? <p className="font-hand text-sm text-muted-foreground">{hint}</p> : null}
        </div>
        {Icon ? (
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-[12px_9px_13px_9px] border-[1.5px]",
              TONES[tone]
            )}
          >
            <Icon className="size-5" />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
