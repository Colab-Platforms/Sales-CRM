"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage } from "@/lib/api-client/client";
import { myAbandonmentSummaryQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import type { TelecallerSummary } from "@/lib/api-client/types/abandonment.types";
import { abandonedLeadsHref } from "@/lib/abandoned-leads-href";

function Card({ label, value, href, hint, testId }: { label: string; value: number; href: string; hint: string; testId: string }) {
  return (
    <Link href={href} data-testid={testId} className="sketch-outline block bg-card/60 p-4 transition-colors hover:bg-muted/50">
      <div className="text-xs font-normal text-muted-foreground">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums" data-testid={`${testId}-value`}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </Link>
  );
}

/** Pure view of a telecaller's own summary (exported for rendering tests). Every card opens THEIR OWN list with the matching date filter. */
export function TelecallerSummaryView({ data }: { data: TelecallerSummary }) {
  return (
    <div className="space-y-3" data-testid="telecaller-summary">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card testId="my-total" label="Total assigned to me" value={data.totalAssigned} href={abandonedLeadsHref({ range: "all" })} hint="everything I currently hold" />
        <Card testId="my-today" label="Today's leads" value={data.today} href={abandonedLeadsHref({ range: "today" })} hint="abandoned today" />
        <Card testId="my-yesterday" label="Yesterday's leads" value={data.yesterday} href={abandonedLeadsHref({ range: "yesterday" })} hint="abandoned yesterday" />
        <Card testId="my-all" label="All my leads" value={data.all} href={abandonedLeadsHref({ range: "all" })} hint="no date restriction" />
        <Card testId="my-new" label="Newly assigned today" value={data.newlyAssignedToday} href={abandonedLeadsHref({ range: "all" })} hint="assigned to me today" />
      </div>
      <p className="text-xs text-muted-foreground">Days follow India time ({data.timezone}). Only leads assigned to you are counted; leads waiting for a telecaller are never part of your workload.</p>
    </div>
  );
}

/** A telecaller's personal lead breakdown. */
export function TelecallerLeadSummary() {
  const { data, isPending, error, refetch } = useQuery(myAbandonmentSummaryQueryOptions());
  return (
    <section className="space-y-3" data-testid="my-leads-section">
      <h2 className="font-heading text-lg font-semibold">My abandoned leads</h2>
      {error ? (
        <div role="alert" data-testid="my-summary-error" className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Could not load your leads.")} <button type="button" className="underline" onClick={() => void refetch()}>Retry</button>
        </div>
      ) : isPending || !data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="my-summary-loading">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
      ) : data.totalAssigned === 0 ? (
        <div className="sketch-outline bg-card/60 p-6 text-center text-sm text-muted-foreground" data-testid="my-summary-empty">No abandoned leads are assigned to you yet.</div>
      ) : (
        <TelecallerSummaryView data={data} />
      )}
    </section>
  );
}
