"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageSquareWarning, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { getErrorMessage } from "@/lib/api-client/client";
import { incentivesApi } from "@/lib/api-client/endpoints/incentives.api";
import { incentiveKeys, myIncentiveQueryOptions } from "@/lib/api-client/queries/incentives.queries";
import type { IncentiveQuery } from "@/lib/api-client/types/incentives.types";
import { istToday } from "@/lib/date-presets";
import { IncentiveMonthView } from "./incentive-month-view";

/** The last 12 months, newest first, as "YYYY-MM". */
export function recentMonths(today: string, count = 12): string[] {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return d.toISOString().slice(0, 7);
  });
}
export const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

/** "My Incentive Plan" on the salesperson's dashboard: their own figures only (the server takes the id from the login). */
export function MyIncentivePlan() {
  const months = recentMonths(istToday());
  const [month, setMonth] = useState(months[0]!);
  const [asking, setAsking] = useState(false);
  const { data, isPending, error, isPlaceholderData, refetch } = useQuery(myIncentiveQueryOptions(month));

  return (
    <section className="space-y-4" aria-labelledby="incentive-plan-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="incentive-plan-title" className="font-heading text-2xl tracking-tight">
            My Incentive Plan
          </h2>
          <p className="text-sm text-muted-foreground">Your revenue, slab and the mandatory conditions, updated from your calls, orders and attendance.</p>
        </div>
        <div className="flex items-center gap-2">
          <NativeSelect value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" wrapperClassName="w-44">
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </NativeSelect>
          <Button variant="outline" size="sm" onClick={() => setAsking(true)} disabled={!data}>
            <MessageSquareWarning data-icon="inline-start" /> Raise a query
          </Button>
        </div>
      </div>

      {isPending ? (
        // White placeholders with a spinner: a plain muted block is nearly the page colour and looked like nothing.
        <div className="space-y-4" aria-busy="true" aria-live="polite">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-28 animate-pulse rounded-xl border border-border bg-card" />
            ))}
          </div>
          <div className="flex h-40 items-center justify-center gap-2 rounded-xl border border-border bg-card text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" aria-hidden="true" /> Loading your incentive plan…
          </div>
        </div>
      ) : error || !data ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <span>{(error as { code?: string } | null)?.code === "ECONNABORTED" ? "The server took too long to respond. Please retry." : getErrorMessage(error, "Your incentive plan could not be loaded.")}</span>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            <RotateCw data-icon="inline-start" /> Retry
          </Button>
        </div>
      ) : (
        <div className={isPlaceholderData ? "space-y-5 opacity-60 transition-opacity" : "space-y-5 transition-opacity"} aria-busy={isPlaceholderData}>
          <IncentiveMonthView data={data} />
          {data.queries.length > 0 ? <MyQueries queries={data.queries} /> : null}
        </div>
      )}

      {asking ? <RaiseQueryDialog month={month} onClose={() => setAsking(false)} /> : null}
    </section>
  );
}

function MyQueries({ queries }: { queries: IncentiveQuery[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>My queries</CardTitle>
        <CardDescription>Questions you raised about this month&apos;s calculation.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {queries.map((q) => (
          <div key={q.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{new Date(q.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
              <span className={q.status === "OPEN" ? "font-medium text-amber-700 dark:text-amber-300" : "font-medium text-emerald-700 dark:text-emerald-300"}>{q.status === "OPEN" ? "Waiting for a reply" : "Answered"}</span>
            </div>
            <p className="mt-1">{q.message}</p>
            {q.response ? (
              <p className="mt-2 rounded bg-muted px-2 py-1.5">
                <span className="font-medium">{q.resolvedBy ?? "Admin"}:</span> {q.response}
              </p>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function RaiseQueryDialog({ month, onClose }: { month: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState("");
  const send = useMutation({
    mutationFn: () => incentivesApi.raiseQuery(month, message.trim()),
    onSuccess: async () => {
      toast.success("Query sent to the admin.");
      await qc.invalidateQueries({ queryKey: incentiveKeys.all });
      onClose();
    },
    onError: (e) => toast.error(getErrorMessage(e, "The query could not be sent.")),
  });
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Raise a query</DialogTitle>
          <DialogDescription>Tell the admin what looks wrong in your {monthLabel(month)} calculation, for example a missing order or day.</DialogDescription>
        </DialogHeader>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          maxLength={1000}
          aria-label="Your query"
          placeholder="e.g. My order for Priya Sharma on 12 Oct is not counted."
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => send.mutate()} disabled={send.isPending || message.trim().length < 5}>
            {send.isPending ? "Sending…" : "Send query"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
