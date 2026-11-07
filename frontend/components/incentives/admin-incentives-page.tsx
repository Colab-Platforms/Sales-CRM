"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, BadgeIndianRupee, Calculator, Download, Hourglass, Plus, Trash2, Users, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiCard } from "@/components/manager-dashboard/kpi-card";
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
import type { ApprovalStatus, IncentiveMonth, IncentiveOverviewRow, IncentivePolicyRules, PaymentStatus } from "@/lib/api-client/types/incentives.types";
import { istToday, shiftDay } from "@/lib/date-presets";
import { cn } from "@/lib/utils";
import { IncentiveMonthView, STATUS_LABEL, StatusPill, inr } from "./incentive-month-view";
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
      <DashboardHeader title="Sales Incentives" subtitle="View and manage salesperson revenue incentives, eligibility, approvals and payments.">
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

type Period = "daily" | "weekly" | "monthly" | "custom";

const hrs = (m: number) => (m <= 0 ? "0h" : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`);
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

const APPROVAL: Record<ApprovalStatus, { label: string; cls: string }> = {
  PENDING: { label: "Pending approval", cls: "bg-amber-400/20 text-amber-900 ring-amber-600/30 dark:text-amber-200" },
  APPROVED: { label: "Approved", cls: "bg-emerald-500/12 text-emerald-900 ring-emerald-600/25 dark:text-emerald-200" },
  REJECTED: { label: "Rejected", cls: "bg-red-500/12 text-red-900 ring-red-600/25 dark:text-red-200" },
  NOT_DUE: { label: "—", cls: "text-muted-foreground ring-transparent" },
};
const PAYMENT: Record<PaymentStatus, { label: string; cls: string }> = {
  PAID: { label: "Paid", cls: "bg-emerald-600 text-white ring-emerald-700" },
  UNPAID: { label: "Unpaid", cls: "bg-amber-400/20 text-amber-900 ring-amber-600/30 dark:text-amber-200" },
  NOT_DUE: { label: "—", cls: "text-muted-foreground ring-transparent" },
};
const Tag = ({ s }: { s: { label: string; cls: string } }) => <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", s.cls)}>{s.label}</span>;

function People() {
  const today = istToday();
  const months = recentMonths(today);
  const [period, setPeriod] = useState<Period>("monthly");
  const [month, setMonth] = useState(months[0]!);
  const [onDay, setOnDay] = useState(today);
  const [from, setFrom] = useState(shiftDay(today, -6));
  const [to, setTo] = useState(today);
  const [personId, setPersonId] = useState("");
  const [eligibility, setEligibility] = useState("");
  const [approval, setApproval] = useState("");
  const [payment, setPayment] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // The official incentive always follows the month the period ends in; daily / weekly / custom only move the
  // performance-tracking window.
  const sel =
    period === "daily"
      ? { month: onDay.slice(0, 7), range: { from: onDay, to: onDay } }
      : period === "weekly"
        ? { month: onDay.slice(0, 7), range: { from: shiftDay(onDay, -6), to: onDay } }
        : period === "custom" && from <= to
          ? { month: to.slice(0, 7), range: { from, to } }
          : { month, range: undefined };
  const { data, isPending, error, isPlaceholderData } = useQuery(incentiveOverviewQueryOptions(sel.month, sel.range));

  const rows = (data?.rows ?? []).filter(
    (r) =>
      (!personId || r.id === personId) &&
      (!eligibility || r.eligibility === eligibility) &&
      (!approval || r.approvalStatus === approval) &&
      (!payment || r.paymentStatus === payment),
  );
  const sum = (pick: (r: IncentiveOverviewRow) => number | null) => rows.reduce((a, r) => a + (pick(r) ?? 0), 0);
  const eligible = rows.filter((r) => r.eligibility === "ELIGIBLE");
  const approved = rows.filter((r) => r.approvedAmount !== null);
  const paid = rows.filter((r) => r.paidAmount !== null);

  const exportXlsx = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const { downloadXlsx } = await import("@/lib/report-xlsx");
      await downloadXlsx(`sales-incentives-${data.month}.xlsx`, [
        {
          name: "Sales Incentives",
          header: [
            "Salesperson", "Employee ID", "Month", "Monthly Revenue", "Revenue Slab", "Prepaid", "Delivery", "Attendance", "Net Login", "Daily Calls", "Avg Daily Orders",
            "Monthly Eligibility", "Calculated Incentive", "Approval Status", "Payment Status", "Approved Amount", "Paid Amount",
            `Calls ${data.range.from}..${data.range.to}`, `Orders ${data.range.from}..${data.range.to}`, `Days targets met ${data.range.from}..${data.range.to}`,
          ],
          rows: rows.map((r) => {
            const c = (k: string) => r.conditions.find((x) => x.key === k)?.actual ?? "";
            return [
              r.name, r.employeeId, data.month, r.revenue, r.currentSlab ? r.currentSlab.minRevenue : "None", c("PREPAID"), c("DELIVERY"), c("ATTENDANCE"), c("NET_LOGIN"), c("DAILY_CALLS"), c("AVG_ORDERS"),
              STATUS_LABEL[r.eligibility], r.incentive ?? 0, APPROVAL[r.approvalStatus].label.replace("—", "Not due"), PAYMENT[r.paymentStatus].label.replace("—", "Not due"), r.approvedAmount ?? 0, r.paidAmount ?? 0,
              r.performance.range.calls, r.performance.range.orders, `${r.performance.range.metDays} of ${r.performance.range.presentDays}`,
            ];
          }),
          money: [3, 12, 15, 16],
          totals: ["Total", "", "", sum((r) => r.revenue), "", "", "", "", "", "", "", "", sum((r) => r.incentive), "", "", sum((r) => r.approvedAmount), sum((r) => r.paidAmount), sum((r) => r.performance.range.calls), sum((r) => r.performance.range.orders), ""],
        },
      ]);
    } catch (e) {
      toast.error(getErrorMessage(e, "The export failed."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Segmented
          label="Period"
          value={period}
          onChange={setPeriod}
          options={[
            { value: "daily", label: "Daily" },
            { value: "weekly", label: "Weekly" },
            { value: "monthly", label: "Monthly" },
            { value: "custom", label: "Custom" },
          ]}
        />
        {period === "monthly" ? (
          <NativeSelect value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" wrapperClassName="w-44">
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </NativeSelect>
        ) : period === "custom" ? (
          <>
            <Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-40" aria-label="From" />
            <Input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-40" aria-label="To" />
          </>
        ) : (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {period === "weekly" ? "Week ending" : "Date"}
            <Input type="date" value={onDay} max={today} onChange={(e) => e.target.value && setOnDay(e.target.value)} className="w-40" />
          </label>
        )}
        <NativeSelect value={personId} onChange={(e) => setPersonId(e.target.value)} aria-label="Salesperson" wrapperClassName="w-44">
          <option value="">All salespeople</option>
          {(data?.rows ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={eligibility} onChange={(e) => setEligibility(e.target.value)} aria-label="Eligibility" wrapperClassName="w-48">
          <option value="">Any eligibility</option>
          {(["ELIGIBLE", "IN_PROGRESS", "PENDING_VERIFICATION", "NOT_ELIGIBLE"] as const).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s].replace(" – Awaiting Admin Approval", "")}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={approval} onChange={(e) => setApproval(e.target.value)} aria-label="Approval status" wrapperClassName="w-44">
          <option value="">Any approval</option>
          <option value="PENDING">Pending approval</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="NOT_DUE">Not due</option>
        </NativeSelect>
        <NativeSelect value={payment} onChange={(e) => setPayment(e.target.value)} aria-label="Payment status" wrapperClassName="w-40">
          <option value="">Any payment</option>
          <option value="PAID">Paid</option>
          <option value="UNPAID">Unpaid</option>
          <option value="NOT_DUE">Not due</option>
        </NativeSelect>
        <Button variant="outline" size="sm" className="ml-auto" onClick={exportXlsx} disabled={!data || exporting || rows.length === 0}>
          <Download data-icon="inline-start" /> {exporting ? "Exporting…" : "Export Excel"}
        </Button>
      </div>

      {period !== "monthly" ? (
        <p className="rounded-md bg-blue-500/8 px-3 py-2 text-xs text-blue-900 dark:text-blue-200">
          {period === "daily" ? "Daily" : period === "weekly" ? "Weekly" : "Custom range"} figures track performance only. The payable incentive always follows the monthly policy - shown here for{" "}
          {monthLabel(sel.month)}.
        </p>
      ) : null}
      {data && data.policy.percentBasis === null ? (
        <p className="rounded-md bg-amber-400/15 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-200">The 2.5% slab&apos;s basis is not confirmed yet - set it in Policy.</p>
      ) : null}

      {isPending ? (
        <Skeleton className="h-96 rounded-lg" />
      ) : error || !data ? (
        errorBox(error, "Incentives could not be loaded.")
      ) : (
        <div className={cn("space-y-4 transition-opacity", isPlaceholderData && "opacity-60")} aria-busy={isPlaceholderData}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <KpiCard label="Total Salespeople" tone="blue" icon={Users} value={String(rows.length)} lines={[{ text: "active salespeople" }]} />
            <KpiCard label="Eligible Salespeople" tone="emerald" icon={BadgeCheck} value={String(eligible.length)} lines={[{ text: `for ${monthLabel(data.month)}` }]} />
            <KpiCard label="Pending Approvals" tone="amber" icon={Hourglass} value={String(rows.filter((r) => r.approvalStatus === "PENDING").length)} lines={[{ text: "eligible, not decided" }]} />
            <KpiCard label="Total Calculated Incentives" tone="violet" icon={Calculator} value={inr(sum((r) => (r.eligibility === "ELIGIBLE" ? r.calculatedIncentive : 0)))} lines={[{ text: "for eligible salespeople" }]} />
            <KpiCard label="Approved Incentives" tone="teal" icon={BadgeIndianRupee} value={inr(sum((r) => r.approvedAmount))} lines={[{ text: `${approved.length} approved` }]} />
            <KpiCard label="Paid Incentives" tone="emerald" icon={Wallet} value={inr(sum((r) => r.paidAmount))} lines={[{ text: `${paid.length} paid` }]} />
          </div>

          <Panel
            title={`${monthLabel(data.month)} · performance ${data.range.from === data.range.to ? day(data.range.to) : `${day(data.range.from)} – ${day(data.range.to)}`}`}
            description={`Daily = ${day(data.range.to)} · Weekly = ${day(data.range.weekFrom)} – ${day(data.range.to)}. A day's targets: ${hrs(data.targets.minNetLoginMinutes)} net login and ${data.targets.minDailyCalls} calls.`}
            bodyClassName="p-0"
          >
            {rows.length === 0 ? (
              <EmptyState>No salespeople match these filters.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
                  <thead className="bg-muted/60 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2.5 text-left font-medium">Salesperson</th>
                      <th className="px-4 py-2.5 text-right font-medium">Monthly Revenue</th>
                      <th className="px-4 py-2.5 text-left font-medium">Revenue Slab</th>
                      <th className="px-4 py-2.5 text-left font-medium">Daily Performance</th>
                      <th className="px-4 py-2.5 text-left font-medium">Weekly Performance</th>
                      {period === "custom" ? <th className="px-4 py-2.5 text-left font-medium">Selected Range</th> : null}
                      <th className="px-4 py-2.5 text-left font-medium">Monthly Eligibility</th>
                      <th className="px-4 py-2.5 text-right font-medium">Calculated Incentive</th>
                      <th className="px-4 py-2.5 text-left font-medium">Approval</th>
                      <th className="px-4 py-2.5 text-left font-medium">Payment</th>
                      <th className="px-4 py-2.5 text-right font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const d = r.performance.day;
                      const w = r.performance.week;
                      const g = r.performance.range;
                      return (
                        <tr key={r.id} className="border-t border-border/60 hover:bg-muted/30">
                          <td className="px-4 py-3">
                            <p className="font-medium">{r.name}</p>
                            {r.openQueries > 0 ? <p className="text-xs text-amber-700 dark:text-amber-300">{r.openQueries} open {r.openQueries === 1 ? "query" : "queries"}</p> : null}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">{inr(r.revenue)}</td>
                          <td className="px-4 py-3">{r.currentSlab ? inr(r.currentSlab.minRevenue) : <span className="text-muted-foreground">None</span>}</td>
                          <td className="px-4 py-3 text-xs">
                            {!d || !d.present ? (
                              <span className="text-muted-foreground">Absent{d && d.calls ? ` · ${d.calls} calls` : ""}</span>
                            ) : (
                              <>
                                <span className={d.met ? "font-medium text-emerald-700 dark:text-emerald-300" : "font-medium text-red-700 dark:text-red-300"}>{d.met ? "Targets met" : "Short"}</span>
                                <span className="block text-muted-foreground tabular-nums">
                                  {d.calls} calls · {d.orders} orders · {hrs(d.netLoginMinutes)}
                                </span>
                              </>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs">
                            <span className="font-medium tabular-nums">
                              {w.metDays} of {w.presentDays} days met
                            </span>
                            <span className="block text-muted-foreground tabular-nums">
                              {w.calls} calls · {w.orders} orders
                            </span>
                          </td>
                          {period === "custom" ? (
                            <td className="px-4 py-3 text-xs">
                              <span className="font-medium tabular-nums">
                                {g.metDays} of {g.presentDays} days met
                              </span>
                              <span className="block text-muted-foreground tabular-nums">
                                {g.calls} calls · {g.orders} orders · {inr(g.revenue)}
                              </span>
                            </td>
                          ) : null}
                          <td className="px-4 py-3">
                            <StatusPill status={r.eligibility} />
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">{r.incentive === null ? <span className="text-muted-foreground">—</span> : inr(r.incentive)}</td>
                          <td className="px-4 py-3">
                            <Tag s={APPROVAL[r.approvalStatus]} />
                          </td>
                          <td className="px-4 py-3">
                            <Tag s={PAYMENT[r.paymentStatus]} />
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Button size="sm" variant="outline" onClick={() => setOpenId(r.id)}>
                              View Details
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}
      {openId ? <MonthDialog userId={openId} month={sel.month} onClose={() => setOpenId(null)} /> : null}
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
          <DialogDescription>
            {data?.record?.status === "REJECTED" ? "Rejected: these are the figures it was rejected on." : data?.locked ? "Approved and locked: these are the figures frozen at approval." : "Live calculation from the CRM's calls, orders and attendance."}
          </DialogDescription>
        </DialogHeader>
        {isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : error || !data ? (
          errorBox(error, "This month could not be loaded.")
        ) : (
          <div className="space-y-5">
            <Actions data={data} />
            <FinalCalculation data={data} />
            <IncentiveMonthView data={data} />
            <History data={data} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The final incentive, step by step: slab -> conditions -> payable amount. */
function FinalCalculation({ data }: { data: IncentiveMonth }) {
  const r = data.result;
  const failed = r.conditions.filter((c) => c.light !== "GREEN");
  const steps = [
    `Revenue: ${inr(r.revenue)} from ${r.totals.orders} verified orders`,
    r.currentSlab ? `Highest slab reached: ${inr(r.currentSlab.minRevenue)} → ${r.currentSlab.incentive}` : `No slab reached (first slab ${inr(r.slabs[0]?.minRevenue ?? 0)})`,
    r.slabIncentive !== null ? `Slab incentive: ${inr(r.slabIncentive)}` : r.slabIncentiveNote ?? "Slab incentive: none",
    failed.length === 0 ? "All 6 mandatory conditions met" : `Not met yet: ${failed.map((c) => c.label).join(", ")}`,
    data.record ? (data.record.status === "REJECTED" ? `Final: ₹0 - rejected (${data.record.rejectionReason ?? "no reason"})` : `Final: ${inr(data.record.amount)} - ${data.record.status === "PAID" ? "approved and paid" : "approved, awaiting payment"}`) : `Final: ${r.potentialIncentive === null ? "—" : inr(r.potentialIncentive)} (${STATUS_LABEL[data.status]})`,
  ];
  return (
    <Panel title="Final incentive calculation">
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </Panel>
  );
}

const HISTORY_LABEL: Record<string, string> = { MONTH_APPROVED: "Approved & locked", MONTH_REJECTED: "Rejected", MONTH_REOPENED: "Reopened", PAYMENT_RECORDED: "Payment recorded" };

function History({ data }: { data: IncentiveMonth }) {
  const h = data.history ?? [];
  return (
    <Panel title="Approval and payment history">
      {h.length === 0 ? (
        <p className="text-sm text-muted-foreground">No decisions yet for this month.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {h.map((e, i) => (
            <li key={i} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{HISTORY_LABEL[e.action] ?? e.action}</span>
              <span className="text-muted-foreground">
                by {e.by ?? "an admin"} · {new Date(e.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
              </span>
              <span className="w-full text-xs text-muted-foreground">{detailText(e.action, e.details)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Actions({ data }: { data: IncentiveMonth }) {
  const qc = useQueryClient();
  const [paying, setPaying] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [ref, setRef] = useState("");
  const [paidOn, setPaidOn] = useState(istToday());
  const [note, setNote] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: incentiveKeys.all });
  const act = (fn: () => Promise<unknown>, done: string, fail: string, after?: () => void) => ({
    mutationFn: fn,
    onSuccess: async () => {
      toast.success(done);
      after?.();
      await refresh();
    },
    onError: (e: unknown) => toast.error(getErrorMessage(e, fail)),
  });
  const approve = useMutation(act(() => incentivesApi.approve(data.salesperson.id, data.month), "Incentive approved and locked.", "Could not approve."));
  const reject = useMutation(act(() => incentivesApi.reject(data.salesperson.id, data.month, reason.trim()), "Incentive rejected.", "Could not reject.", () => setRejecting(false)));
  const reopen = useMutation(act(() => incentivesApi.reopen(data.salesperson.id, data.month), "Month reopened.", "Could not reopen."));
  const pay = useMutation(
    act(() => incentivesApi.recordPayment(data.salesperson.id, data.month, { paymentRef: ref.trim() || undefined, note: note.trim() || undefined, paidOn }), "Payment recorded.", "Could not record the payment.", () => setPaying(false)),
  );

  const r = data.record;
  const monthOver = data.month < data.today.slice(0, 7);
  const canDecide = !r && monthOver && (data.status === "ELIGIBLE" || data.status === "PENDING_VERIFICATION");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
      <div className="max-w-2xl">
        {r?.status === "REJECTED" ? (
          <span>
            Rejected by {r.approvedBy ?? "an admin"} on {new Date(r.approvedAt).toLocaleDateString("en-IN")}: {r.rejectionReason}
          </span>
        ) : r ? (
          <span>
            Approved {inr(r.amount)} by {r.approvedBy ?? "an admin"} on {new Date(r.approvedAt).toLocaleDateString("en-IN")}
            {r.status === "PAID" ? ` · Paid ${r.paidAt ? new Date(r.paidAt).toLocaleDateString("en-IN") : ""}${r.paymentRef ? ` (ref ${r.paymentRef})` : ""} by ${r.paidBy ?? "an admin"}` : " · payment not recorded yet"}
          </span>
        ) : !monthOver ? (
          <span className="text-muted-foreground">The month is still running - it can be approved or rejected after it ends.</span>
        ) : data.status === "ELIGIBLE" ? (
          <span>All conditions are met. Approving locks the figures and the amount of {data.result.slabIncentive === null ? "—" : inr(data.result.slabIncentive)}.</span>
        ) : (
          <span className="text-muted-foreground">Cannot be approved: {data.result.statusReason}.</span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {canDecide && data.status === "ELIGIBLE" ? (
          <Button size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>
            {approve.isPending ? "Approving…" : "Approve & lock"}
          </Button>
        ) : null}
        {canDecide ? (
          <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
            Reject
          </Button>
        ) : null}
        {r?.status === "REJECTED" ? (
          <Button size="sm" variant="outline" onClick={() => reopen.mutate()} disabled={reopen.isPending}>
            {reopen.isPending ? "Reopening…" : "Reopen"}
          </Button>
        ) : null}
        {r?.status === "APPROVED" ? (
          <Button size="sm" onClick={() => setPaying(true)}>
            Record payment
          </Button>
        ) : null}
      </div>
      {rejecting ? (
        <Dialog open onOpenChange={(o) => (!o ? setRejecting(false) : undefined)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Reject incentive</DialogTitle>
              <DialogDescription>
                {data.salesperson.name} · {monthLabel(data.month)}. The salesperson sees the reason on their plan.
              </DialogDescription>
            </DialogHeader>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              maxLength={500}
              aria-label="Rejection reason"
              placeholder="e.g. Delivery figures could not be verified for this month."
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => reject.mutate()} disabled={reject.isPending || reason.trim().length < 5}>
                {reject.isPending ? "Rejecting…" : "Reject"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
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
  MONTH_REJECTED: "Rejected",
  MONTH_REOPENED: "Reopened",
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
  if (action === "MONTH_REJECTED") return `Reason: ${String(d.reason ?? "")}`;
  if (action === "MONTH_REOPENED") return d.previousReason ? `Previously rejected: ${String(d.previousReason)}` : "Rejection undone";
  if (action === "QUERY_RAISED") return String(d.message ?? "");
  if (action === "QUERY_ANSWERED") return String(d.response ?? "");
  if (action === "POLICY_UPDATED") return "Slabs and conditions changed (before / after stored)";
  return JSON.stringify(d);
}
