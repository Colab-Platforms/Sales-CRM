import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/*
  Every card stays white; the tone only tints its icon chip. "primary" (the
  dark chip) marks the headline metric, so use it once per row.
*/
const TONES = {
  default: "bg-muted text-muted-foreground",
  primary: "bg-highlight-foreground text-highlight",
  teal: "bg-teal-500/10 text-teal-700 dark:text-teal-300",
  amber: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  emerald: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
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
      <CardContent className="flex h-full flex-col justify-between gap-6">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm text-muted-foreground">{label}</p>
          {Icon ? (
            <div
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full",
                TONES[tone]
              )}
            >
              <Icon className="size-4" />
            </div>
          ) : null}
        </div>
        <div className="flex items-end justify-between gap-3">
          <p className="font-heading text-4xl leading-none font-normal tracking-tight tabular-nums">
            {value}
          </p>
          {hint ? (
            <p className="text-xs text-muted-foreground">{hint}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
