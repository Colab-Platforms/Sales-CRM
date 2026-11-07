"use client";

import { useState } from "react";
import { BadgeCheck, CircleCheck, CircleDashed, CircleX, IndianRupee, Layers, Wallet } from "lucide-react";
import { StatCard } from "@/components/dashboard/stat-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { IncentiveCondition, IncentiveDailyRow, IncentiveMonth, IncentiveStatus, Light } from "@/lib/api-client/types/incentives.types";
import { cn } from "@/lib/utils";

export const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const hours = (m: number) => (m <= 0 ? "—" : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`);
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", weekday: "short", timeZone: "UTC" });

export const STATUS_LABEL: Record<IncentiveStatus, string> = {
  IN_PROGRESS: "In Progress",
  ELIGIBLE: "Eligible – Awaiting Admin Approval",
  APPROVED: "Approved",
  PAID: "Paid",
  NOT_ELIGIBLE: "Not Eligible",
  PENDING_VERIFICATION: "Pending Data Verification",
};

export const STATUS_STYLE: Record<IncentiveStatus, string> = {
  IN_PROGRESS: "bg-blue-500/10 text-blue-800 ring-blue-600/20 dark:text-blue-200",
  ELIGIBLE: "bg-emerald-500/10 text-emerald-800 ring-emerald-600/25 dark:text-emerald-200",
  APPROVED: "bg-emerald-500/15 text-emerald-900 ring-emerald-600/30 dark:text-emerald-200",
  PAID: "bg-emerald-600 text-white ring-emerald-700",
  NOT_ELIGIBLE: "bg-red-500/10 text-red-800 ring-red-600/25 dark:text-red-200",
  PENDING_VERIFICATION: "bg-amber-400/20 text-amber-900 ring-amber-600/30 dark:text-amber-200",
};

export const LIGHT_STYLE: Record<Light, { ring: string; dot: string; text: string; label: string }> = {
  GREEN: { ring: "ring-emerald-600/25 bg-emerald-500/8", dot: "bg-emerald-500", text: "text-emerald-800 dark:text-emerald-200", label: "Achieved" },
  AMBER: { ring: "ring-amber-600/30 bg-amber-400/10", dot: "bg-amber-400", text: "text-amber-900 dark:text-amber-200", label: "In progress" },
  RED: { ring: "ring-red-600/25 bg-red-500/8", dot: "bg-red-500", text: "text-red-800 dark:text-red-200", label: "Not achieved" },
};

const LIGHT_ICON = { GREEN: CircleCheck, AMBER: CircleDashed, RED: CircleX } as const;

export function StatusPill({ status }: { status: IncentiveStatus }) {
  return <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", STATUS_STYLE[status])}>{STATUS_LABEL[status]}</span>;
}

/** One salesperson's month: summary cards, slab progress, the six conditions and the daily table. */
export function IncentiveMonthView({ data }: { data: IncentiveMonth }) {
  const r = data.result;
  const [open, setOpen] = useState<IncentiveCondition | null>(null);
  const met = r.conditions.filter((c) => c.light === "GREEN").length;
  const incentiveValue = data.record ? inr(data.record.amount) : r.potentialIncentive === null ? "—" : inr(r.potentialIncentive);
  const incentiveHint = data.record
    ? data.record.status === "PAID"
      ? "paid"
      : "approved"
    : !r.currentSlab
      ? "no slab reached yet"
      : r.potentialIncentive === null
        ? "awaiting admin confirmation"
        : r.potentialIncentive === 0
          ? "a condition is not met"
          : r.isCurrentMonth
            ? "if conditions stay met"
            : "for this month";

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Monthly Revenue" value={inr(r.revenue)} hint={`${r.totals.orders} orders`} icon={IndianRupee} tone="primary" />
        <StatCard label="Current Incentive Slab" value={r.currentSlab ? inr(r.currentSlab.minRevenue) : "None yet"} hint={r.currentSlab ? r.currentSlab.incentive : `first slab ${inr(r.slabs[0]?.minRevenue ?? 0)}`} icon={Layers} tone="teal" />
        <StatCard label="Potential Incentive" value={incentiveValue} hint={incentiveHint ?? undefined} icon={Wallet} tone="emerald" />
        <Card className="transition-transform hover:-translate-y-0.5">
          <CardContent className="flex h-full flex-col justify-between gap-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-muted-foreground">Eligibility Status</p>
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-500/12 text-amber-700 dark:text-amber-300">
                <BadgeCheck className="size-4" />
              </div>
            </div>
            <div className="space-y-1.5">
              <StatusPill status={data.status} />
              <p className="text-xs text-muted-foreground">
                {met} of {r.conditions.length} conditions met · {data.record ? (data.record.status === "PAID" ? `paid${data.record.paidAt ? ` ${new Date(data.record.paidAt).toLocaleDateString("en-IN")}` : ""}` : "approved and locked") : r.statusReason}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <SlabProgress data={data} />

      <Card>
        <CardHeader>
          <CardTitle>Mandatory conditions</CardTitle>
          <CardDescription>All six must be met to receive the incentive. Select a condition to see how it is calculated.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {r.conditions.map((c) => {
              const s = LIGHT_STYLE[c.light];
              const Icon = LIGHT_ICON[c.light];
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setOpen(c)}
                  className={cn("rounded-lg p-3 text-left ring-1 ring-inset transition-colors hover:brightness-95 focus-visible:outline-2 focus-visible:outline-ring", s.ring)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium">{c.label}</p>
                    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", s.text)}>
                      <Icon className="size-3.5" aria-hidden="true" /> {s.label}
                    </span>
                  </div>
                  <p className="mt-2 text-lg font-semibold tabular-nums">
                    {c.actual} <span className="text-sm font-normal text-muted-foreground">/ {c.required}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{c.summary}</p>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <DailyTable rows={r.daily} />

      <Dialog open={open !== null} onOpenChange={(o) => (!o ? setOpen(null) : undefined)}>
        <DialogContent className="sm:max-w-lg">
          {open ? (
            <>
              <DialogHeader>
                <DialogTitle>{open.label}</DialogTitle>
                <DialogDescription>
                  {open.actual} against a minimum of {open.required} · <span className={LIGHT_STYLE[open.light].text}>{LIGHT_STYLE[open.light].label}</span>
                </DialogDescription>
              </DialogHeader>
              <ul className="space-y-2 text-sm">
                {open.details.map((d, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SlabProgress({ data }: { data: IncentiveMonth }) {
  const r = data.result;
  const prev = r.currentSlab?.minRevenue ?? 0;
  const next = r.nextSlab?.minRevenue ?? null;
  const progress = next === null ? 100 : Math.min(100, Math.max(0, ((r.revenue - prev) / (next - prev)) * 100));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue slab progress</CardTitle>
        <CardDescription>Only the highest slab you reach applies - slab incentives are not added together.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span>
              <span className="font-semibold tabular-nums">{inr(r.revenue)}</span> achieved
              {r.currentSlab ? <span className="text-muted-foreground"> · slab {inr(r.currentSlab.minRevenue)}</span> : null}
            </span>
            {r.nextSlab ? (
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground tabular-nums">{inr(r.nextSlab.remaining)}</span> more to reach {inr(r.nextSlab.minRevenue)} ({r.nextSlab.incentive})
              </span>
            ) : (
              <span className="font-medium text-emerald-700 dark:text-emerald-300">Top slab reached</span>
            )}
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} aria-label="Progress to the next slab">
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {r.slabs.map((s) => {
            const current = r.currentSlab?.minRevenue === s.minRevenue;
            return (
              <div key={s.minRevenue} className={cn("rounded-md border px-3 py-2 text-xs", current ? "border-emerald-600 bg-emerald-500/10" : s.achieved ? "border-emerald-600/30" : "border-border text-muted-foreground")}>
                <p className="font-semibold tabular-nums text-foreground">{inr(s.minRevenue)}</p>
                <p>{s.incentive}</p>
                {current ? <p className="mt-0.5 font-medium text-emerald-700 dark:text-emerald-300">Your slab</p> : null}
              </div>
            );
          })}
        </div>
        {r.slabIncentiveNote ? <p className="rounded-md bg-amber-400/15 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">{r.slabIncentiveNote}</p> : null}
      </CardContent>
    </Card>
  );
}

const DAY_STATUS: Record<IncentiveDailyRow["status"], { label: string; cls: string }> = {
  MET: { label: "Targets met", cls: "text-emerald-700 dark:text-emerald-300" },
  SHORT: { label: "Short", cls: "text-red-700 dark:text-red-300" },
  ABSENT: { label: "Absent", cls: "text-muted-foreground" },
  TODAY: { label: "Today", cls: "text-blue-700 dark:text-blue-300" },
  UPCOMING: { label: "—", cls: "text-muted-foreground/60" },
  NOT_JOINED: { label: "—", cls: "text-muted-foreground/60" },
};

function DailyTable({ rows }: { rows: IncentiveDailyRow[] }) {
  const shown = rows.filter((d) => d.status !== "UPCOMING");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily performance</CardTitle>
        <CardDescription>&quot;Targets met&quot; = present, with the daily net login and call targets both reached that day.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
            <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
              <tr>
                <th className="px-5 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-right font-medium">Calls</th>
                <th className="px-3 py-2 text-right font-medium">Orders</th>
                <th className="px-3 py-2 text-right font-medium">Net Login Hours</th>
                <th className="px-3 py-2 text-left font-medium">Attendance</th>
                <th className="px-5 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted-foreground">
                    No days yet this month.
                  </td>
                </tr>
              ) : (
                [...shown].reverse().map((d) => (
                  <tr key={d.date} className="border-t border-border/60">
                    <td className="px-5 py-2">{dayLabel(d.date)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.calls}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.orders}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{hours(d.netLoginMinutes)}</td>
                    <td className="px-3 py-2">{d.attendance === "PRESENT" ? "Present" : d.attendance === "PENDING" ? "Not yet" : d.attendance === "ABSENT" ? "Absent" : "—"}</td>
                    <td className={cn("px-5 py-2 font-medium", DAY_STATUS[d.status].cls)}>{DAY_STATUS[d.status].label}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
