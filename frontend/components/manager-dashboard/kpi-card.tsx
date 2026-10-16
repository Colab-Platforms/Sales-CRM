import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/manager-analytics";
import { Sparkline } from "./svg-charts";

const TONES = {
  blue: { card: "bg-blue-50/70 border-blue-100 dark:bg-blue-500/10 dark:border-blue-500/20", bar: "bg-blue-500", spark: "text-blue-500", chip: "bg-blue-500/10 text-blue-700 dark:text-blue-300" },
  slate: { card: "bg-slate-50 border-slate-200 dark:bg-slate-500/10 dark:border-slate-500/20", bar: "bg-slate-400", spark: "text-slate-500", chip: "bg-slate-500/10 text-slate-700 dark:text-slate-300" },
  teal: { card: "bg-teal-50/70 border-teal-100 dark:bg-teal-500/10 dark:border-teal-500/20", bar: "bg-teal-500", spark: "text-teal-500", chip: "bg-teal-500/10 text-teal-700 dark:text-teal-300" },
  amber: { card: "bg-amber-50/70 border-amber-100 dark:bg-amber-500/10 dark:border-amber-500/20", bar: "bg-amber-400", spark: "text-amber-500", chip: "bg-amber-500/12 text-amber-700 dark:text-amber-300" },
  emerald: { card: "bg-emerald-50/70 border-emerald-100 dark:bg-emerald-500/10 dark:border-emerald-500/20", bar: "bg-emerald-500", spark: "text-emerald-500", chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  violet: { card: "bg-violet-50/70 border-violet-100 dark:bg-violet-500/10 dark:border-violet-500/20", bar: "bg-violet-500", spark: "text-violet-500", chip: "bg-violet-500/10 text-violet-700 dark:text-violet-300" },
} as const;

export type KpiTone = keyof typeof TONES;

export function KpiCard({
  label,
  value,
  lines,
  accent,
  spark,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  lines?: { text: string; tone?: "default" | "positive" | "negative" }[];
  accent?: boolean;
  spark?: number[];
  tone?: KpiTone;
  icon?: LucideIcon;
}) {
  const t = tone ? TONES[tone] : null;
  return (
    <div className={cn("relative flex flex-col overflow-hidden rounded-[6px] border p-3.5 shadow-[0_1px_2px_rgb(0_0_0/0.03),0_6px_16px_-6px_rgb(0_0_0/0.08)]", t ? t.card : "border-border bg-card", accent && !t && "border-l-2 border-l-primary")}>
      <div className="flex min-w-0 items-center gap-2">
        {Icon ? (
          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", t ? t.chip : "bg-muted text-muted-foreground")} aria-hidden="true">
            <Icon className="size-3.5" />
          </span>
        ) : null}
        <p className="truncate text-xs text-muted-foreground">{label}</p>
      </div>
      <p className="mt-2.5 truncate text-[1.375rem] leading-none font-semibold tracking-tight tabular-nums">{value}</p>
      {lines?.length ? (
        <div className="mt-2 space-y-0.5">
          {lines.map((l) => (
            <p
              key={l.text}
              className={cn(
                "text-xs",
                l.tone === "positive" ? "text-emerald-600 dark:text-emerald-400" : l.tone === "negative" ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
              )}
            >
              {l.text}
            </p>
          ))}
        </div>
      ) : null}
      {spark ? <div className="mt-auto pt-2"><Sparkline values={spark} colorClass={t?.spark} /></div> : null}
    </div>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

const WORK_STATUS: Record<string, { label: string; dot: string }> = {
  ACTIVE: { label: "Active", dot: "bg-emerald-500" },
  ON_CALL: { label: "On call", dot: "bg-blue-500" },
  IDLE: { label: "Idle", dot: "bg-amber-500" },
  TEA_BREAK: { label: "Tea break", dot: "bg-amber-500" },
  LUNCH_BREAK: { label: "Lunch", dot: "bg-amber-500" },
  BIO_BREAK: { label: "Break", dot: "bg-amber-500" },
  TEAM_HUDDLE: { label: "Huddle", dot: "bg-violet-500" },
  OFFLINE: { label: "Offline", dot: "bg-muted-foreground/50" },
};

export function WorkStatusDot({ status }: { status: string }) {
  const s = WORK_STATUS[status] ?? WORK_STATUS.OFFLINE!;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", s.dot)} aria-hidden="true" />
      {s.label}
    </span>
  );
}
