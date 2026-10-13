"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, buttonVariants } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/api-client/client";
import { abandonmentDistributionQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import type { AbandonmentDateRange, AbandonmentDistribution } from "@/lib/api-client/types/abandonment.types";
import { abandonedLeadsHref } from "@/lib/abandoned-leads-href";
import { cn } from "@/lib/utils";

const PERIODS: { value: AbandonmentDateRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "all", label: "All Leads" },
];

const PERIOD_NOUN: Record<AbandonmentDateRange, string> = { today: "today", yesterday: "yesterday", all: "in total" };

function StatCard({ label, value, href, hint, tone, testId }: { label: string; value: number; href: string; hint?: string; tone?: "alert"; testId: string }) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className={cn("sketch-outline block bg-card/60 p-4 transition-colors hover:bg-muted/50", tone === "alert" && value > 0 && "border-destructive/50 bg-destructive/5")}
    >
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-3xl font-bold tabular-nums" data-testid={`${testId}-value`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </Link>
  );
}

/** Pure view of one distribution answer - exported so it can be rendered and tested without a network. */
export function LeadDistributionView({ data, range }: { data: AbandonmentDistribution; range: AbandonmentDateRange }) {
  const s = data.summary;
  const to = (state: Parameters<typeof abandonedLeadsHref>[0]) => abandonedLeadsHref(state);
  const noun = PERIOD_NOUN[range];
  return (
    <div className="space-y-4" data-testid="lead-distribution">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard testId="card-total" label={range === "all" ? "Total leads" : `Total leads ${noun}`} value={s.total} href={to({ range })} hint="abandoned in this period" />
        <StatCard testId="card-assigned" label="Assigned to a telecaller" value={s.assigned} href={to({ range })} hint="in this period" />
        <StatCard testId="card-unassigned" label="Unassigned" value={s.unassigned} href={to({ range, assignment: "UNASSIGNED_TELECALLER" })} tone="alert" hint={`${s.unassignedAllTime} awaiting a telecaller in total`} />
        <StatCard testId="card-telecallers" label="Telecallers with leads" value={s.telecallersWithLeads} href={to({ range })} hint="in this period" />
        <StatCard testId="card-today" label="Today's leads" value={s.todayTotal} href={to({ range: "today" })} hint="abandoned today" />
        <StatCard testId="card-yesterday" label="Yesterday's leads" value={s.yesterdayTotal} href={to({ range: "yesterday" })} hint="abandoned yesterday" />
      </div>

      {s.unassignedAllTime > 0 ? (
        <Link
          href={to({ range: "all", assignment: "UNASSIGNED_TELECALLER" })}
          data-testid="unassigned-banner"
          className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm font-medium text-destructive hover:bg-destructive/10"
        >
          <AlertTriangle className="size-4" aria-hidden />
          {s.unassignedAllTime} abandoned {s.unassignedAllTime === 1 ? "lead is" : "leads are"} still waiting for a telecaller — view and assign
        </Link>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="telecaller-table">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Telecaller</th>
                  <th className="px-4 py-3 text-right font-medium">Total assigned<div className="font-normal">currently</div></th>
                  <th className="px-4 py-3 text-right font-medium">{range === "all" ? "All leads" : `Leads ${noun}`}<div className="font-normal">by abandon date</div></th>
                  <th className="px-4 py-3 text-right font-medium">Today&apos;s<div className="font-normal">abandoned today</div></th>
                  <th className="px-4 py-3 text-right font-medium">Yesterday&apos;s<div className="font-normal">abandoned yesterday</div></th>
                  <th className="px-4 py-3 text-right font-medium">Assigned today<div className="font-normal">by assignment time</div></th>
                  <th className="px-4 py-3 text-right font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {data.telecallers.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground" data-testid="telecaller-empty">
                      <Users className="mx-auto mb-2 size-5" aria-hidden />
                      No telecallers to show yet.
                    </td>
                  </tr>
                ) : (
                  data.telecallers.map((t) => (
                    <tr key={t.userId} className="border-b last:border-0" data-testid={`telecaller-row-${t.userId}`}>
                      <td className="px-4 py-3 font-medium">{t.name}</td>
                      <Cell value={t.totalAssigned} href={to({ range: "all", salespersonId: t.userId })} testId={`total-${t.userId}`} />
                      <Cell value={t.inPeriod} href={to({ range, salespersonId: t.userId })} testId={`period-${t.userId}`} />
                      <Cell value={t.todayAbandoned} href={to({ range: "today", salespersonId: t.userId })} testId={`today-${t.userId}`} />
                      <Cell value={t.yesterdayAbandoned} href={to({ range: "yesterday", salespersonId: t.userId })} testId={`yesterday-${t.userId}`} />
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground" data-testid={`assigned-today-${t.userId}`}>{t.assignedToday}</td>
                      <td className="px-4 py-3 text-right">
                        <Link href={to({ range, salespersonId: t.userId })} data-testid={`details-${t.userId}`} className={buttonVariants({ size: "sm", variant: "outline" })}>View details</Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground" data-testid="distribution-legend">
        Days follow India time ({data.timezone}). &ldquo;Abandoned&rdquo; counts use the time the checkout was abandoned; &ldquo;Assigned today&rdquo; uses the time of the telecaller&apos;s current assignment; &ldquo;Total assigned&rdquo; is everything a telecaller holds right now. Unassigned leads have no telecaller yet and are counted once, in the cards above.
      </p>
    </div>
  );
}

function Cell({ value, href, testId }: { value: number; href: string; testId: string }) {
  return (
    <td className="px-4 py-3 text-right tabular-nums">
      {value > 0 ? (
        <Link href={href} className="font-semibold text-primary underline-offset-2 hover:underline" data-testid={testId}>{value}</Link>
      ) : (
        <span className="text-muted-foreground" data-testid={testId}>0</span>
      )}
    </td>
  );
}

/** Admin / Manager / HR: total leads, assigned vs unassigned, and each telecaller's share, for Today / Yesterday / All Leads. Refreshes after any assignment. */
export function LeadDistributionDashboard({ title = "Abandoned leads distribution" }: { title?: string }) {
  const [range, setRange] = useState<AbandonmentDateRange>("today");
  const { data, isPending, error, refetch } = useQuery(abandonmentDistributionQueryOptions(range));
  return (
    <section className="space-y-4" data-testid="distribution-section">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-extrabold">{title}</h2>
        <div role="group" aria-label="Distribution period" className="flex gap-2">
          {PERIODS.map((p) => (
            <Button key={p.value} type="button" size="sm" variant={p.value === range ? "default" : "outline"} aria-pressed={p.value === range} data-testid={`dist-period-${p.value}`} onClick={() => setRange(p.value)}>
              {p.label}
            </Button>
          ))}
        </div>
      </div>
      {error ? (
        <div role="alert" data-testid="distribution-error" className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Could not load the lead distribution.")}{" "}
          <button type="button" className="underline" onClick={() => void refetch()}>Retry</button>
        </div>
      ) : isPending || !data ? (
        <div data-testid="distribution-loading" className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : (
        <LeadDistributionView data={data} range={range} />
      )}
    </section>
  );
}
