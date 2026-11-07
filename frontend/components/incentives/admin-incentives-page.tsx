"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardHeader } from "@/components/manager-dashboard/manager-sales-dashboard";
import { EmptyState, Panel, Segmented } from "@/components/manager-dashboard/panel";
import { getErrorMessage } from "@/lib/api-client/client";
import { incentivesApi } from "@/lib/api-client/endpoints/incentives.api";
import {
  incentiveAuditQueryOptions,
  incentiveKeys,
  incentiveMonthQueryOptions,
  incentiveOverviewQueryOptions,
  incentivePolicyQueryOptions,
  incentiveQueriesQueryOptions,
} from "@/lib/api-client/queries/incentives.queries";
import type { IncentiveMonth, IncentivePolicyRules } from "@/lib/api-client/types/incentives.types";
import { istToday } from "@/lib/date-presets";
import { cn } from "@/lib/utils";
import { IncentiveMonthView, LIGHT_STYLE, StatusPill, inr } from "./incentive-month-view";
import { monthLabel, recentMonths } from "./my-incentive-plan";

type Tab = "people" | "queries" | "policy" | "audit";

const errorBox = (error: unknown, fallback: string) => (
  <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
    {getErrorMessage(error, fallback)}
  </div>
);

export function AdminIncentivesPage() {
  const [tab, setTab] = useState<Tab>("people");
  return (
    <div className="space-y-5">
      <DashboardHeader title="Incentives" subtitle="Review each salesperson's monthly incentive, approve and record payments.">
        <Segmented
          label="Incentive section"
          value={tab}
          onChange={setTab}
          options={[
            { value: "people", label: "Salespeople" },
            { value: "queries", label: "Queries" },
            { value: "policy", label: "Policy" },
            { value: "audit", label: "Audit log" },
          ]}
        />
      </DashboardHeader>
      {tab === "people" ? <People /> : tab === "queries" ? <Queries /> : tab === "policy" ? <Policy /> : <Audit />}
    </div>
  );
}

function People() {
  const months = recentMonths(istToday());
  const [month, setMonth] = useState(months[0]!);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isPending, error, isPlaceholderData } = useQuery(incentiveOverviewQueryOptions(month));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <NativeSelect value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" wrapperClassName="w-48">
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </NativeSelect>
        {data && data.policy.percentBasis === null ? (
          <p className="rounded-md bg-amber-400/15 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-200">The 2.5% slab&apos;s basis is not confirmed yet - set it in Policy.</p>
        ) : null}
      </div>
      {isPending ? (
        <Skeleton className="h-80 rounded-lg" />
      ) : error || !data ? (
        errorBox(error, "Incentives could not be loaded.")
      ) : (
        <Panel title={monthLabel(month)} description="Select a salesperson to see the full calculation, approve it or record the payment." bodyClassName="p-0">
          {data.rows.length === 0 ? (
            <EmptyState>No active salespeople.</EmptyState>
          ) : (
            <div className={cn("overflow-x-auto", isPlaceholderData && "opacity-60")}>
              <table className="w-full text-sm [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">Salesperson</th>
                    <th className="px-4 py-2.5 text-right font-medium">Revenue</th>
                    <th className="px-4 py-2.5 text-left font-medium">Slab</th>
                    <th className="px-4 py-2.5 text-left font-medium">Conditions</th>
                    <th className="px-4 py-2.5 text-right font-medium">Incentive</th>
                    <th className="px-4 py-2.5 text-left font-medium">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium">Queries</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="cursor-pointer border-t border-border/60 hover:bg-muted/30" onClick={() => setOpenId(r.id)}>
                      <td className="px-4 py-3 font-medium">
                        <button type="button" className="text-left hover:underline" onClick={() => setOpenId(r.id)}>
                          {r.name}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{inr(r.revenue)}</td>
                      <td className="px-4 py-3">{r.currentSlab ? inr(r.currentSlab.minRevenue) : <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          {r.conditions.map((c) => (
                            <span key={c.key} title={`${c.label}: ${c.actual} (${LIGHT_STYLE[c.light].label})`} className={cn("size-3 rounded-full", LIGHT_STYLE[c.light].dot)} />
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{r.incentive === null ? "—" : inr(r.incentive)}</td>
                      <td className="px-4 py-3">
                        <StatusPill status={r.status} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{r.openQueries > 0 ? <span className="font-medium text-amber-700 dark:text-amber-300">{r.openQueries} open</span> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
      {openId ? <MonthDialog userId={openId} month={month} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

function MonthDialog({ userId, month, onClose }: { userId: string; month: string; onClose: () => void }) {
  const { data, isPending, error } = useQuery(incentiveMonthQueryOptions(userId, month));
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>{data ? `${data.salesperson.name} · ${monthLabel(month)}` : monthLabel(month)}</DialogTitle>
          <DialogDescription>{data?.locked ? "Approved and locked: these are the figures frozen at approval." : "Live calculation from the CRM's calls, orders and attendance."}</DialogDescription>
        </DialogHeader>
        {isPending ? <Skeleton className="h-96 w-full" /> : error || !data ? errorBox(error, "This month could not be loaded.") : (
          <div className="space-y-5">
            <Actions data={data} />
            <IncentiveMonthView data={data} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Actions({ data }: { data: IncentiveMonth }) {
  const qc = useQueryClient();
  const [paying, setPaying] = useState(false);
  const [ref, setRef] = useState("");
  const [paidOn, setPaidOn] = useState(istToday());
  const [note, setNote] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: incentiveKeys.all });
  const approve = useMutation({
    mutationFn: () => incentivesApi.approve(data.salesperson.id, data.month),
    onSuccess: async () => {
      toast.success("Incentive approved and locked.");
      await refresh();
    },
    onError: (e) => toast.error(getErrorMessage(e, "Could not approve.")),
  });
  const pay = useMutation({
    mutationFn: () => incentivesApi.recordPayment(data.salesperson.id, data.month, { paymentRef: ref.trim() || undefined, note: note.trim() || undefined, paidOn }),
    onSuccess: async () => {
      toast.success("Payment recorded.");
      setPaying(false);
      await refresh();
    },
    onError: (e) => toast.error(getErrorMessage(e, "Could not record the payment.")),
  });

  const r = data.record;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
      <div>
        {r ? (
          <span>
            Approved {inr(r.amount)} by {r.approvedBy ?? "an admin"} on {new Date(r.approvedAt).toLocaleDateString("en-IN")}
            {r.status === "PAID" ? ` · Paid ${r.paidAt ? new Date(r.paidAt).toLocaleDateString("en-IN") : ""}${r.paymentRef ? ` (ref ${r.paymentRef})` : ""} by ${r.paidBy ?? "an admin"}` : " · payment not recorded yet"}
          </span>
        ) : data.status === "ELIGIBLE" ? (
          <span>All conditions are met. Approving locks the figures and the amount of {data.result.slabIncentive === null ? "—" : inr(data.result.slabIncentive)}.</span>
        ) : (
          <span className="text-muted-foreground">Cannot be approved: {data.result.statusReason}.</span>
        )}
      </div>
      <div className="flex gap-2">
        {!r && data.status === "ELIGIBLE" ? (
          <Button size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>
            {approve.isPending ? "Approving…" : "Approve & lock"}
          </Button>
        ) : null}
        {r?.status === "APPROVED" ? (
          <Button size="sm" onClick={() => setPaying(true)}>
            Record payment
          </Button>
        ) : null}
      </div>
      {paying ? (
        <Dialog open onOpenChange={(o) => (!o ? setPaying(false) : undefined)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Record payment</DialogTitle>
              <DialogDescription>
                {data.salesperson.name} · {monthLabel(data.month)} · {r ? inr(r.amount) : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <label className="grid gap-1 text-sm">
                Paid on
                <Input type="date" value={paidOn} max={istToday()} onChange={(e) => setPaidOn(e.target.value)} />
              </label>
              <label className="grid gap-1 text-sm">
                Payment reference (optional)
                <Input value={ref} maxLength={120} onChange={(e) => setRef(e.target.value)} placeholder="e.g. UTR / payroll batch" />
              </label>
              <label className="grid gap-1 text-sm">
                Note (optional)
                <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
              </label>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPaying(false)}>
                Cancel
              </Button>
              <Button onClick={() => pay.mutate()} disabled={pay.isPending || !paidOn}>
                {pay.isPending ? "Saving…" : "Mark as paid"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function Queries() {
  const [status, setStatus] = useState<"OPEN" | "RESOLVED" | "">("OPEN");
  const { data, isPending, error } = useQuery(incentiveQueriesQueryOptions(status || undefined));
  return (
    <div className="space-y-4">
      <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Query status" wrapperClassName="w-44">
        <option value="OPEN">Open</option>
        <option value="RESOLVED">Answered</option>
        <option value="">All</option>
      </NativeSelect>
      {isPending ? <Skeleton className="h-60 rounded-lg" /> : error || !data ? errorBox(error, "Queries could not be loaded.") : data.length === 0 ? (
        <Panel>
          <EmptyState>No queries.</EmptyState>
        </Panel>
      ) : (
        <div className="space-y-3">
          {data.map((q) => (
            <QueryCard key={q.id} q={q} />
          ))}
        </div>
      )}
    </div>
  );
}

function QueryCard({ q }: { q: Awaited<ReturnType<typeof incentivesApi.queries>>[number] }) {
  const qc = useQueryClient();
  const [reply, setReply] = useState("");
  const answer = useMutation({
    mutationFn: () => incentivesApi.resolveQuery(q.id, reply.trim()),
    onSuccess: async () => {
      toast.success("Reply sent.");
      await qc.invalidateQueries({ queryKey: incentiveKeys.all });
    },
    onError: (e) => toast.error(getErrorMessage(e, "Could not send the reply.")),
  });
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{q.name}</span> · {monthLabel(q.month)} · {new Date(q.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
        </span>
        <span className={q.status === "OPEN" ? "font-medium text-amber-700 dark:text-amber-300" : "font-medium text-emerald-700 dark:text-emerald-300"}>{q.status === "OPEN" ? "Open" : "Answered"}</span>
      </div>
      <p className="mt-2">{q.message}</p>
      {q.status === "RESOLVED" ? (
        <p className="mt-2 rounded bg-muted px-2 py-1.5">
          <span className="font-medium">{q.resolvedBy ?? "Admin"}:</span> {q.response}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Input value={reply} onChange={(e) => setReply(e.target.value)} maxLength={1000} placeholder="Write a reply" aria-label="Reply" className="min-w-64 flex-1" />
          <Button size="sm" onClick={() => answer.mutate()} disabled={answer.isPending || reply.trim().length < 2}>
            {answer.isPending ? "Sending…" : "Reply & resolve"}
          </Button>
        </div>
      )}
    </div>
  );
}

function Policy() {
  const { data, isPending, error } = useQuery(incentivePolicyQueryOptions());
  if (isPending) return <Skeleton className="h-96 rounded-lg" />;
  if (error || !data) return errorBox(error, "The policy could not be loaded.");
  return <PolicyForm key={data.updatedAt ?? "default"} initial={data.rules} configured={data.configured} />;
}

function PolicyForm({ initial, configured }: { initial: IncentivePolicyRules; configured: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState<IncentivePolicyRules>(initial);
  const save = useMutation({
    mutationFn: () => incentivesApi.setPolicy(f),
    onSuccess: async () => {
      toast.success("Policy saved.");
      await qc.invalidateQueries({ queryKey: incentiveKeys.all });
    },
    onError: (e) => toast.error(getErrorMessage(e, "The policy could not be saved.")),
  });
  const num = (v: string) => (v.trim() === "" ? 0 : Number(v));
  const setSlab = (i: number, p: Partial<IncentivePolicyRules["slabs"][number]>) => setF((x) => ({ ...x, slabs: x.slabs.map((s, j) => (j === i ? { ...s, ...p } : s)) }));
  const field = (label: string, key: keyof Omit<IncentivePolicyRules, "slabs" | "percentBasis">, suffix: string, scale = 1) => (
    <label className="grid gap-1 text-sm">
      {label}
      <div className="flex items-center gap-2">
        <Input type="number" min={0} step={key === "minAvgDailyOrders" ? 0.1 : 1} value={f[key] / scale} onChange={(e) => setF((x) => ({ ...x, [key]: Math.round(num(e.target.value) * scale * 10) / 10 }))} className="w-28" />
        <span className="text-xs text-muted-foreground">{suffix}</span>
      </div>
    </label>
  );

  return (
    <div className="space-y-5">
      {!configured ? <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Showing the defaults from the Sales Revenue Incentive Policy sheet. Nothing has been saved yet.</p> : null}
      <Panel title="Revenue slabs" description="The highest slab reached applies; slabs are never added together.">
        <div className="space-y-2">
          {f.slabs.map((s, i) => {
            const isPct = s.percent !== undefined;
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">From ₹</span>
                <Input type="number" min={1} value={s.minRevenue} onChange={(e) => setSlab(i, { minRevenue: num(e.target.value) })} className="w-32" aria-label="Slab revenue" />
                <NativeSelect value={isPct ? "percent" : "amount"} onChange={(e) => setSlab(i, e.target.value === "percent" ? { percent: s.amount ?? 1, amount: undefined } : { amount: s.percent ?? 0, percent: undefined })} aria-label="Incentive type" wrapperClassName="w-36">
                  <option value="amount">Fixed ₹</option>
                  <option value="percent">Percentage %</option>
                </NativeSelect>
                <Input type="number" min={0} step={isPct ? 0.1 : 1} value={isPct ? s.percent : s.amount} onChange={(e) => setSlab(i, isPct ? { percent: num(e.target.value) } : { amount: num(e.target.value) })} className="w-28" aria-label="Incentive" />
                <Button variant="ghost" size="icon-sm" aria-label="Remove slab" onClick={() => setF((x) => ({ ...x, slabs: x.slabs.filter((_, j) => j !== i) }))} disabled={f.slabs.length <= 1}>
                  <Trash2 />
                </Button>
              </div>
            );
          })}
          <Button variant="outline" size="sm" onClick={() => setF((x) => ({ ...x, slabs: [...x.slabs, { minRevenue: (x.slabs.at(-1)?.minRevenue ?? 0) + 50000, amount: 0 }] }))}>
            <Plus data-icon="inline-start" /> Add slab
          </Button>
        </div>
        <label className="mt-4 grid max-w-xl gap-1 text-sm">
          How a percentage slab is applied
          <NativeSelect value={f.percentBasis ?? ""} onChange={(e) => setF((x) => ({ ...x, percentBasis: (e.target.value || null) as IncentivePolicyRules["percentBasis"] }))} aria-label="Percentage basis">
            <option value="">Not confirmed yet - do not calculate</option>
            <option value="TOTAL">Of the month&apos;s total revenue</option>
            <option value="ABOVE_SLAB">Only of the revenue above that slab</option>
          </NativeSelect>
        </label>
      </Panel>
      <Panel title="Mandatory conditions" description="All must be met. Day-based conditions count qualifying days, checked one day at a time.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {field("Prepaid orders", "minPrepaidPercent", "% minimum")}
          {field("Delivery achievement", "minDeliveryPercent", "% minimum")}
          {field("Attendance", "minAttendanceDays", "days present")}
          {field("Net login per day", "minNetLoginMinutes", "hours", 60)}
          {field("…on at least", "minLoginDays", "days")}
          {field("Calls per day", "minDailyCalls", "calls")}
          {field("…on at least", "minCallDays", "days")}
          {field("Average daily orders", "minAvgDailyOrders", "orders per day present")}
        </div>
      </Panel>
      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save policy"}
        </Button>
      </div>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  POLICY_UPDATED: "Policy updated",
  MONTH_APPROVED: "Approved & locked",
  PAYMENT_RECORDED: "Payment recorded",
  QUERY_RAISED: "Query raised",
  QUERY_ANSWERED: "Query answered",
};

function Audit() {
  const { data, isPending, error } = useQuery(incentiveAuditQueryOptions());
  if (isPending) return <Skeleton className="h-60 rounded-lg" />;
  if (error || !data) return errorBox(error, "The audit log could not be loaded.");
  return (
    <Panel title="Audit log" description="Every policy change, approval, payment and query, newest first." bodyClassName="p-0">
      {data.length === 0 ? (
        <EmptyState>Nothing recorded yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium whitespace-nowrap">When</th>
                <th className="px-4 py-2.5 text-left font-medium">Action</th>
                <th className="px-4 py-2.5 text-left font-medium">By</th>
                <th className="px-4 py-2.5 text-left font-medium">Salesperson</th>
                <th className="px-4 py-2.5 text-left font-medium">Month</th>
                <th className="px-4 py-2.5 text-left font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className="border-t border-border/60 align-top">
                  <td className="px-4 py-2.5 whitespace-nowrap">{new Date(e.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{ACTION_LABEL[e.action] ?? e.action}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{e.actor ?? "—"}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{e.salesperson ?? "—"}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{e.month ? monthLabel(e.month) : "—"}</td>
                  <td className="max-w-md px-4 py-2.5 text-xs break-words text-muted-foreground">{detailText(e.action, e.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function detailText(action: string, d: Record<string, unknown>): string {
  if (action === "MONTH_APPROVED") return `${inr(Number(d.amount))} on revenue ${inr(Number(d.revenue))}${d.note ? ` · ${d.note}` : ""}`;
  if (action === "PAYMENT_RECORDED") return `${inr(Number(d.amount))}${d.paymentRef ? ` · ref ${d.paymentRef}` : ""}${d.note ? ` · ${d.note}` : ""}`;
  if (action === "QUERY_RAISED") return String(d.message ?? "");
  if (action === "QUERY_ANSWERED") return String(d.response ?? "");
  if (action === "POLICY_UPDATED") return "Slabs and conditions changed (before / after stored)";
  return JSON.stringify(d);
}
