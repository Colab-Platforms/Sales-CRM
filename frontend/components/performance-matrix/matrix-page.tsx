"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, PhoneCall, ShoppingBag, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiCard } from "@/components/manager-dashboard/kpi-card";
import { DashboardHeader } from "@/components/manager-dashboard/manager-sales-dashboard";
import { EmptyState, Panel, Segmented } from "@/components/manager-dashboard/panel";
import { getErrorMessage } from "@/lib/api-client/client";
import { performanceMatrixQueryOptions } from "@/lib/api-client/queries/performance-matrix.queries";
import type { MatrixHour, MatrixRow, MatrixState, PerformanceMatrix } from "@/lib/api-client/types/performance-matrix.types";
import { istToday, shiftDay } from "@/lib/date-presets";
import { formatDay, formatNumber } from "@/lib/manager-analytics";
import { cn } from "@/lib/utils";

type View = "hourly" | "daily";

export const STATE_LABEL: Record<MatrixState, string> = {
  GREEN: "Green",
  AMBER: "Amber",
  RED: "Red",
  IN_PROGRESS: "In progress",
  UPCOMING: "Upcoming",
  OFF_SHIFT: "Off shift",
  NO_DATA: "No Data",
};

const STATE_MEANING: Partial<Record<MatrixState, string>> = {
  GREEN: "Good activity",
  AMBER: "Needs attention",
  RED: "Low activity",
};

const CELL_STYLE: Record<MatrixState, string> = {
  GREEN: "bg-emerald-500/12 text-emerald-900 ring-emerald-600/25 dark:text-emerald-200",
  AMBER: "bg-amber-400/20 text-amber-900 ring-amber-600/30 dark:text-amber-200",
  RED: "bg-red-500/12 text-red-900 ring-red-600/25 dark:text-red-200",
  IN_PROGRESS: "bg-blue-500/8 text-foreground ring-blue-600/20",
  UPCOMING: "bg-transparent text-muted-foreground/70 ring-border/60",
  OFF_SHIFT: "bg-muted/50 text-muted-foreground ring-border",
  NO_DATA: "bg-violet-500/8 text-muted-foreground ring-violet-600/20",
};

const DOT: Partial<Record<MatrixState, string>> = { GREEN: "bg-emerald-500", AMBER: "bg-amber-400", RED: "bg-red-500" };

/** Who needs attention first: Red, Amber, Green, then the not-rated. */
const ORDER: Record<MatrixState, number> = { RED: 0, AMBER: 1, GREEN: 2, IN_PROGRESS: 3, NO_DATA: 4, UPCOMING: 5, OFF_SHIFT: 6 };

type StatusFilter = "" | "ATTENTION" | "RED" | "AMBER" | "GREEN" | "OFF_SHIFT";
const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "ATTENTION", label: "Requiring attention" },
  { value: "RED", label: "Red" },
  { value: "AMBER", label: "Amber" },
  { value: "GREEN", label: "Green" },
  { value: "OFF_SHIFT", label: "Off shift" },
];
const matchesStatus = (s: MatrixState, f: StatusFilter) => !f || (f === "ATTENTION" ? s === "RED" || s === "AMBER" : s === f);

/** Colour dot plus a text label, so the status reads without colour. */
function StatusPill({ state, reason }: { state: MatrixState; reason?: string }) {
  return (
    <span title={reason} className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", CELL_STYLE[state])}>
      <span className={cn("size-2 rounded-full", DOT[state] ?? "bg-muted-foreground/40")} aria-hidden="true" />
      {STATE_LABEL[state]}
    </span>
  );
}

const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? "" : "s"}`;

const clock12 = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}`;
};

export function PerformanceMatrixPage({ role }: { role: "MANAGER" | "ADMIN" }) {
  const today = istToday();
  const [view, setView] = useState<View>("hourly");
  const [date, setDate] = useState(today);
  const [managerId, setManagerId] = useState("");
  const [salespersonId, setSalespersonId] = useState("");
  const [slot, setSlot] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");

  const query = { date, ...(salespersonId ? { salespersonId } : {}), ...(managerId ? { managerId } : {}) };
  const { data, isPending, error, isPlaceholderData, isFetching } = useQuery(performanceMatrixQueryOptions(query));
  const rows = (data?.rows ?? []).filter((r) => matchesStatus(r.status, status)).sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));

  return (
    <div className="space-y-5">
      <DashboardHeader title="Performance Matrix" subtitle="Monitor salesperson activity and order performance">
        <Segmented
          label="Matrix view"
          value={view}
          onChange={setView}
          options={[
            { value: "hourly", label: "Hourly Matrix" },
            { value: "daily", label: "Daily Matrix" },
          ]}
        />
      </DashboardHeader>

      {/* ---- filters ---- */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex gap-1.5" role="group" aria-label="Quick date">
          {[
            { label: "Today", value: today },
            { label: "Yesterday", value: shiftDay(today, -1) },
          ].map((d) => (
            <Button key={d.label} size="sm" variant={date === d.value ? "default" : "outline"} onClick={() => setDate(d.value)}>
              {d.label}
            </Button>
          ))}
        </div>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Date
          <Input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-40" />
        </label>
        {role === "ADMIN" ? (
          <label className="grid gap-1 text-xs text-muted-foreground">
            Team
            <NativeSelect
              value={managerId}
              onChange={(e) => {
                setManagerId(e.target.value);
                setSalespersonId("");
              }}
              wrapperClassName="w-48"
              aria-label="Team"
            >
              <option value="">All teams</option>
              {(data?.managers ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}&apos;s team
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : null}
        <label className="grid gap-1 text-xs text-muted-foreground">
          Salesperson
          <NativeSelect value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)} wrapperClassName="w-48" aria-label="Salesperson">
            <option value="">All salespeople</option>
            {(data?.team ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Status
          <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} wrapperClassName="w-44" aria-label="Status">
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </NativeSelect>
        </label>
        {view === "hourly" ? (
          <label className="grid gap-1 text-xs text-muted-foreground">
            Time slot
            <NativeSelect value={slot} onChange={(e) => setSlot(e.target.value)} wrapperClassName="w-40" aria-label="Time slot">
              <option value="">All hours</option>
              {(data?.slots ?? []).map((s) => (
                <option key={s.key} value={s.key}>
                  {clock12(s.start)}–{clock12(s.end)}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : null}
      </div>

      {isPending ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-[6px]" />
            ))}
          </div>
          <Skeleton className="h-80 rounded-lg" />
        </div>
      ) : error || !data ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "The Performance Matrix could not be loaded. Please try again.")}
        </div>
      ) : (
        <div className={cn("space-y-4 transition-opacity", isPlaceholderData && "opacity-60")} aria-busy={isPlaceholderData}>
          <p className="text-xs text-muted-foreground">
            {formatDay(data.date, "long")}
            {data.isToday ? " (today)" : ""} · IST · {isFetching ? "refreshing…" : `updated ${new Date(data.generatedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}, refreshes every minute`}
          </p>

          {!data.dataAvailable ? (
            <p className="rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-900 dark:text-violet-200">
              No call records exist for the team on this date, so activity is shown as <strong>No Data</strong> rather than zero. If people were working, the call feed may be missing.
            </p>
          ) : null}

          <Summary data={data} />

          {rows.length === 0 ? (
            <Panel>
              <EmptyState>No salespeople match these filters.</EmptyState>
            </Panel>
          ) : view === "hourly" ? (
            <HourlyMatrix data={data} rows={rows} slot={slot} />
          ) : (
            <DailyMatrix rows={rows} />
          )}
        </div>
      )}
    </div>
  );
}

function Summary({ data }: { data: PerformanceMatrix }) {
  const s = data.summary;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiCard label="Total Calls" tone="violet" icon={PhoneCall} value={formatNumber(s.totalCalls)} lines={[{ text: "call attempts, any outcome" }]} />
      <KpiCard label="Total Actual Orders" tone="emerald" icon={ShoppingBag} value={formatNumber(s.totalOrders)} lines={[{ text: "confirmed / placed orders" }]} />
      <KpiCard label="Salespeople" tone="blue" icon={Users} value={formatNumber(s.salespeople)} lines={[{ text: `${s.byStatus.GREEN} green · ${s.byStatus.AMBER} amber · ${s.byStatus.RED} red` }]} />
      <KpiCard label="Requiring Attention" tone="amber" icon={AlertTriangle} value={formatNumber(s.needAttention)} lines={[{ text: "Amber or Red for the day" }]} />
    </div>
  );
}

/** The salesperson carries the colour: their performance over the whole day, login to logout. */
function NameCell({ row }: { row: MatrixRow }) {
  return (
    <div title={row.reason} className={cn("w-48 rounded-md px-2.5 py-1.5 ring-1 ring-inset", CELL_STYLE[row.status])}>
      <div className="flex items-center gap-2">
        <span className={cn("size-2.5 shrink-0 rounded-full", DOT[row.status] ?? "bg-muted-foreground/40")} aria-hidden="true" />
        <p className="truncate font-medium">{row.name}</p>
      </div>
      <p className="mt-0.5 text-[11px] font-medium opacity-80">
        {STATE_LABEL[row.status]}
        {STATE_MEANING[row.status] ? ` · ${STATE_MEANING[row.status]}` : ""}
      </p>
    </div>
  );
}

/** An hour's counts only - no colour; the colour belongs to the salesperson. */
function HourCell({ h, label }: { h: MatrixHour | undefined; label: string }) {
  if (!h) return <span className="text-muted-foreground">·</span>;
  const idle = h.state === "UPCOMING" || h.state === "OFF_SHIFT" || h.state === "NO_DATA";
  return (
    <div
      title={`${label}: ${h.calls} call${h.calls === 1 ? "" : "s"}, ${h.orders} order${h.orders === 1 ? "" : "s"}${idle ? ` - ${STATE_LABEL[h.state]}` : ""}`}
      className={cn("mx-auto w-24 rounded-md bg-card px-2 py-1.5 text-left text-xs ring-1 ring-inset ring-border", idle && "bg-muted/40 text-muted-foreground")}
    >
      <div className="flex justify-between gap-2">
        <span className="opacity-75">Calls</span>
        <span className="font-semibold tabular-nums">{h.state === "NO_DATA" ? "—" : h.calls}</span>
      </div>
      <div className="flex justify-between gap-2">
        <span className="opacity-75">Orders</span>
        <span className="font-semibold tabular-nums">{h.state === "NO_DATA" ? "—" : h.orders}</span>
      </div>
    </div>
  );
}

function HourlyMatrix({ data, rows, slot }: { data: PerformanceMatrix; rows: MatrixRow[]; slot: string }) {
  const cols = data.slots.filter((s) => !slot || s.key === slot);
  const showOutside = !slot && rows.some((r) => r.outside.calls + r.outside.orders > 0);
  // Today's running hour (it is In progress for everyone).
  const nowKey = data.isToday ? data.rows[0]?.hours.find((h) => h.state === "IN_PROGRESS")?.key : undefined;
  const hourTotal = (key: string, what: "calls" | "orders") => rows.reduce((a, r) => a + (r.hours.find((h) => h.key === key)?.[what] ?? 0), 0);
  const sum = (f: (r: MatrixRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  return (
    <Panel title="Hourly Matrix" description="Calls and actual orders in each hour. Each salesperson is coloured by their performance for the day - hover the name for why." bodyClassName="p-0">
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-sm [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
          <thead className="sticky top-0 z-20 bg-muted text-xs text-muted-foreground">
            <tr>
              <th className="sticky left-0 z-30 border-b border-border bg-muted px-3 py-2 text-left font-medium">Salesperson</th>
              {cols.map((s) => (
                <th key={s.key} className={cn("border-b border-border px-2 py-2 text-center font-medium", s.key === nowKey && "bg-blue-500/10 text-foreground")}>
                  {clock12(s.start)}–{clock12(s.end)}
                  {s.key === nowKey ? <div className="text-[10px] font-semibold text-blue-700 dark:text-blue-300">Now</div> : null}
                </th>
              ))}
              {showOutside ? (
                <th className="border-b border-border px-2 py-2 text-right font-medium" title="Before 9:30 AM or after 6:30 PM">
                  Outside hours
                </th>
              ) : null}
              <th className="border-b border-border px-3 py-2 text-right font-medium">Daily Calls</th>
              <th className="border-b border-border px-3 py-2 text-right font-medium">Daily Orders</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const byKey = new Map(r.hours.map((h) => [h.key, h]));
              return (
                <tr key={r.id} className="hover:bg-muted/30">
                  <td className="sticky left-0 z-10 border-b border-border/60 bg-card px-3 py-2">
                    <NameCell row={r} />
                  </td>
                  {cols.map((s) => (
                    <td key={s.key} className={cn("border-b border-border/60 px-1.5 py-1.5 text-center", s.key === nowKey && "bg-blue-500/5")}>
                      <HourCell h={byKey.get(s.key)} label={`${clock12(s.start)}–${clock12(s.end)}`} />
                    </td>
                  ))}
                  {showOutside ? (
                    <td className="border-b border-border/60 px-2 py-2 text-right text-xs text-muted-foreground tabular-nums">
                      {r.outside.calls} {r.outside.calls === 1 ? "call" : "calls"}
                      <br />
                      {r.outside.orders} {r.outside.orders === 1 ? "order" : "orders"}
                    </td>
                  ) : null}
                  <td className="border-b border-border/60 px-3 py-2 text-right font-semibold tabular-nums">{formatNumber(r.totals.calls)}</td>
                  <td className="border-b border-border/60 px-3 py-2 text-right font-semibold tabular-nums">{formatNumber(r.totals.orders)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="sticky bottom-0 z-20 bg-muted text-xs font-semibold">
            <tr>
              <td className="sticky left-0 z-30 border-t border-border bg-muted px-3 py-2">Total</td>
              {cols.map((s) => (
                <td key={s.key} className="border-t border-border px-2 py-2 text-center tabular-nums">
                  <div>{plural(hourTotal(s.key, "calls"), "call")}</div>
                  <div>{plural(hourTotal(s.key, "orders"), "order")}</div>
                </td>
              ))}
              {showOutside ? (
                <td className="border-t border-border px-2 py-2 text-right tabular-nums">
                  {sum((r) => r.outside.calls)} · {sum((r) => r.outside.orders)}
                </td>
              ) : null}
              <td className="border-t border-border px-3 py-2 text-right tabular-nums">{formatNumber(sum((r) => r.totals.calls))}</td>
              <td className="border-t border-border px-3 py-2 text-right tabular-nums">{formatNumber(sum((r) => r.totals.orders))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}

const timeOfDay = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");
const duration = (minutes: number) => (minutes < 1 ? "—" : `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}m`);

function DailyMatrix({ rows }: { rows: MatrixRow[] }) {
  const calls = rows.reduce((a, r) => a + r.totals.calls, 0);
  const orders = rows.reduce((a, r) => a + r.totals.orders, 0);
  const minutes = rows.reduce((a, r) => a + r.clockedInMinutes, 0);
  return (
    <Panel title="Daily Matrix" description="Each salesperson's whole day, login to logout: total calls and actual orders, rated against the team." bodyClassName="p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-sm [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
          <thead className="bg-muted/60 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Salesperson</th>
              <th className="px-4 py-2.5 text-left font-medium">Login</th>
              <th className="px-4 py-2.5 text-left font-medium">Logout</th>
              <th className="px-4 py-2.5 text-right font-medium">Logged in</th>
              <th className="px-4 py-2.5 text-right font-medium">Total Calls</th>
              <th className="px-4 py-2.5 text-right font-medium">Actual Orders</th>
              <th className="px-4 py-2.5 text-right font-medium">Calls / hr</th>
              <th className="px-4 py-2.5 text-left font-medium">RAG Status</th>
              <th className="px-4 py-2.5 text-left font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border/60 hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">{r.name}</td>
                <td className="px-4 py-3 tabular-nums">{timeOfDay(r.loginAt)}</td>
                <td className="px-4 py-3 tabular-nums">{r.stillLoggedIn ? <span className="text-emerald-700 dark:text-emerald-300">Still logged in</span> : timeOfDay(r.logoutAt)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{duration(r.clockedInMinutes)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.status === "NO_DATA" ? "—" : formatNumber(r.totals.calls)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.status === "NO_DATA" ? "—" : formatNumber(r.totals.orders)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.callsPerHour ?? "—"}</td>
                <td className="px-4 py-3">
                  <StatusPill state={r.status} reason={r.reason} />
                </td>
                <td className="min-w-64 px-4 py-3 text-xs whitespace-normal text-muted-foreground">{r.reason}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border bg-muted/60 font-semibold">
            <tr>
              <td className="px-4 py-3">Total</td>
              <td className="px-4 py-3" colSpan={2} />
              <td className="px-4 py-3 text-right tabular-nums">{duration(minutes)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatNumber(calls)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatNumber(orders)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{minutes >= 1 ? Math.round((calls * 600) / minutes) / 10 : "—"}</td>
              <td className="px-4 py-3" colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}
