"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Download, Percent, UserCheck, UserX, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { KpiCard } from "@/components/manager-dashboard/kpi-card";
import { EmptyState, Panel } from "@/components/manager-dashboard/panel";
import { StackedBarChart } from "@/components/manager-dashboard/svg-charts";
import { getErrorMessage } from "@/lib/api-client/client";
import { attendanceApi } from "@/lib/api-client/endpoints/attendance.api";
import { attendanceRecordsQueryOptions } from "@/lib/api-client/queries/attendance.queries";
import type {
  AttendanceDayRecord,
  AttendanceRecords,
  AttendanceRecordsQuery,
  AttendanceStatusFilter,
} from "@/lib/api-client/types/attendance.types";
import { DAY_STATUS_CODE, DAY_STATUS_LABEL, exportAttendanceCsv, exportAttendanceXlsx, istTime } from "@/lib/attendance-export";
import { formatHours, todayInReportZone } from "@/lib/attendance";
import { cn } from "@/lib/utils";
import { DAY_STATUS_STYLE, DayStatusBadge } from "./day-status-badge";
import { DATE_PRESETS, DATE_PRESET_LABELS, presetError, resolvePreset, shiftDay, type DatePreset } from "@/lib/date-presets";

// ---------- date presets (shared with every report; India business days, same as the server) ----------

type Preset = DatePreset;
const PRESETS = DATE_PRESETS.map((value) => ({ value, label: DATE_PRESET_LABELS[value] }));

interface Draft {
  preset: Preset;
  single: string;
  from: string;
  to: string;
  userId: string;
  status: AttendanceStatusFilter;
}

const initialDraft = (): Draft => {
  const today = todayInReportZone();
  return { preset: "today", single: today, from: shiftDay(today, -6), to: today, userId: "", status: "ALL" };
};

/** The inclusive date range a draft stands for, or an error message. */
export function rangeOf(d: Draft): { from: string; to: string } | { error: string } {
  const error = presetError(d);
  return error ? { error } : resolvePreset(d);
}

// ---------- small pieces ----------

const STATUS_BADGE = DAY_STATUS_STYLE;
const StatusBadge = DayStatusBadge;

const dayLabel = (ymd: string) =>
  new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const weekday = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" });
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);

// ---------- main ----------

export function AttendanceReport() {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [applied, setApplied] = useState<Draft>(initialDraft);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const draftRange = rangeOf(draft);
  const appliedRange = rangeOf(applied);
  const query: AttendanceRecordsQuery | null =
    "error" in appliedRange ? null : { ...appliedRange, userId: applied.userId || undefined, status: applied.status, page, pageSize: 50 };
  const { data, isPending, error, isPlaceholderData } = useQuery({
    ...attendanceRecordsQueryOptions(query ?? { from: "", to: "", status: "ALL" }),
    enabled: query !== null,
  });

  const apply = () => {
    if ("error" in draftRange) return;
    setApplied(draft);
    setPage(1);
  };
  // A quick range (Today, Yesterday, ...) loads at once - otherwise clicking "Today" kept showing the last
  // applied range until Apply was pressed. Single Date / Custom Range still wait for Apply (dates to pick first).
  const choosePreset = (preset: Preset) => {
    const next = { ...draft, preset };
    setDraft(next);
    if (preset !== "single" && preset !== "custom") {
      setApplied(next);
      setPage(1);
    }
  };
  const reset = () => {
    const fresh = initialDraft();
    setDraft(fresh);
    setApplied(fresh);
    setPage(1);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);

  const employeeName = applied.userId ? (data?.team.find((t) => t.id === applied.userId)?.name ?? "Selected employee") : "All employees";
  const runExport = async (kind: "csv" | "xlsx") => {
    if (!query) return;
    setExporting(true);
    try {
      // Everyone on one page, so the file has every matching employee, not just the visible page.
      const all = await attendanceApi.getRecords({ ...query, page: 1, pageSize: 1000 });
      const name = `attendance-${all.range.from}_${all.range.to}`;
      if (kind === "csv") exportAttendanceCsv(`${name}.csv`, all, employeeName);
      else await exportAttendanceXlsx(`${name}.xlsx`, all, employeeName);
    } catch (e) {
      toast.error(getErrorMessage(e, "The export could not be created. Please try again."));
    } finally {
      setExporting(false);
    }
  };

  const openEmployee = (id: string) => router.push(`/dashboard/salespersons/${id}`);

  return (
    <Panel title="Attendance Report" description="Present and absent days from real clock-ins. Present = clocked in that day; absent = no clock-in on a working day.">
      <div className="space-y-5">
        {/* ---- filters ---- */}
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Date range">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => choosePreset(p.value)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  draft.preset === p.value ? "border-foreground bg-foreground text-background" : "border-border bg-card hover:bg-muted",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {draft.preset === "single" ? (
              <label className="grid gap-1 text-xs text-muted-foreground">
                Date
                <Input type="date" value={draft.single} max={todayInReportZone()} onChange={(e) => patch({ single: e.target.value })} className="w-40" />
              </label>
            ) : null}
            {draft.preset === "custom" ? (
              <>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  From
                  <Input type="date" value={draft.from} max={draft.to || todayInReportZone()} onChange={(e) => patch({ from: e.target.value })} className="w-40" />
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  To
                  <Input type="date" value={draft.to} min={draft.from || undefined} max={todayInReportZone()} onChange={(e) => patch({ to: e.target.value })} className="w-40" />
                </label>
              </>
            ) : null}
            <label className="grid gap-1 text-xs text-muted-foreground">
              Employee
              <NativeSelect value={draft.userId} onChange={(e) => patch({ userId: e.target.value })} wrapperClassName="w-48" aria-label="Employee">
                <option value="">All Employees</option>
                {(data?.team ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Status
              <NativeSelect value={draft.status} onChange={(e) => patch({ status: e.target.value as AttendanceStatusFilter })} wrapperClassName="w-36" aria-label="Attendance status">
                <option value="ALL">All</option>
                <option value="PRESENT">Present</option>
                <option value="ABSENT">Absent</option>
              </NativeSelect>
            </label>
            <div className="flex gap-2">
              <Button size="sm" onClick={apply} disabled={"error" in draftRange || !dirty}>
                Apply Filters
              </Button>
              <Button size="sm" variant="outline" onClick={reset}>
                Reset
              </Button>
            </div>
            <div className="ml-auto">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={!data || exporting} />}>
                  <Download data-icon="inline-start" /> {exporting ? "Exporting…" : "Export"}
                  <ChevronDown className="size-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={() => void runExport("xlsx")} className="flex-col items-start gap-0.5">
                    <span className="text-sm">Excel (.xlsx)</span>
                    <span className="text-xs text-muted-foreground">Matrix, daily records and summary</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void runExport("csv")} className="flex-col items-start gap-0.5">
                    <span className="text-sm">CSV</span>
                    <span className="text-xs text-muted-foreground">One row per employee per day</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {"error" in draftRange ? <p className="text-xs text-destructive">{draftRange.error}</p> : null}
          {dirty && !("error" in draftRange) ? <p className="text-xs text-muted-foreground">Filters changed — press Apply Filters to update.</p> : null}
        </div>

        {/* ---- results ---- */}
        {isPending ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-[6px]" />
              ))}
            </div>
            <Skeleton className="h-64 rounded-md" />
          </div>
        ) : error || !data ? (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            {getErrorMessage(error, "Could not load attendance.")}
          </div>
        ) : (
          <div className={cn("space-y-5 transition-opacity", isPlaceholderData && "opacity-60")} aria-busy={isPlaceholderData}>
            <Summary data={data} />
            {data.range.days.length > 1 ? <TrendChart data={data} /> : null}
            {data.employees.length === 0 ? (
              <EmptyState>No attendance matches these filters.</EmptyState>
            ) : applied.userId && data.range.days.length > 1 ? (
              <RecordsTable mode="history" data={data} onOpen={openEmployee} />
            ) : data.range.days.length === 1 ? (
              <RecordsTable mode="day" data={data} onOpen={openEmployee} />
            ) : (
              <Matrix data={data} onOpen={openEmployee} />
            )}
            {data.pagination.pages > 1 ? (
              <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                <span>
                  Page {data.pagination.page} of {data.pagination.pages} · {data.pagination.total} employees
                </span>
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="outline" disabled={page >= data.pagination.pages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Summary({ data }: { data: AttendanceRecords }) {
  const s = data.summary;
  const multi = data.range.days.length > 1;
  // Over several days these are employee-days (one per employee per day), not distinct people.
  const unit = multi ? "employee-days" : "employees";
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Employees" tone="blue" icon={Users} value={String(s.totalEmployees)} lines={[{ text: multi ? `${data.range.days.length} days` : data.range.from }]} />
        <KpiCard label="Present" tone="emerald" icon={UserCheck} value={String(s.present)} lines={[{ text: unit }]} />
        <KpiCard label="Absent" tone="red" icon={UserX} value={String(s.absent)} lines={[{ text: unit }]} />
        <KpiCard label="Attendance %" tone="violet" icon={Percent} value={pct(s.attendancePct)} lines={[{ text: s.expected ? `${s.attended} of ${s.expected} working ${multi ? "days" : "employees"}` : "Nothing expected yet" }]} />
      </div>
      <p className="text-xs text-muted-foreground">
        Half-day, leave, holidays and weekly offs aren&apos;t tracked in this CRM, so every day counts as a working day. Today shows &quot;Not Yet Recorded&quot; until {data.policy.cutoff} IST; after that, anyone not clocked in counts as absent (a later clock-in makes them present);
        days before an employee joined{data.policy.trackingStartedOn ? ` or before attendance tracking began (${data.policy.trackingStartedOn})` : ""} are left out.
      </p>
    </div>
  );
}

function TrendChart({ data }: { data: AttendanceRecords }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">Daily attendance</h3>
      <StackedBarChart
        labels={data.daily.map((d) => dayLabel(d.date))}
        tooltipTitles={data.daily.map((d) => `${weekday(d.date)} ${dayLabel(d.date)} · ${pct(d.attendancePct)} attendance`)}
        height={200}
        series={[
          { key: "present", label: "Present", values: data.daily.map((d) => d.present), colorClass: "text-emerald-500" },
          { key: "absent", label: "Absent", values: data.daily.map((d) => d.absent), colorClass: "text-red-500" },
        ]}
      />
    </div>
  );
}

/** Employee-wise matrix: one row per employee, one column per day. */
function Matrix({ data, onOpen }: { data: AttendanceRecords; onOpen: (id: string) => void }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/60 text-xs text-muted-foreground">
          <tr>
            <th className="sticky left-0 z-10 min-w-44 bg-muted px-3 py-2 text-left font-medium">Employee</th>
            {data.range.days.map((d) => (
              <th key={d} className="px-1.5 py-2 text-center font-medium whitespace-nowrap">
                <div>{dayLabel(d)}</div>
                <div className="text-[10px] font-normal">{weekday(d)}</div>
              </th>
            ))}
            {["Present", "Absent", "Att. %", "Talk Time"].map((h) => (
              <th key={h} className="px-2 py-2 text-right font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.employees.map((e) => (
            <tr key={e.id} className="border-t border-border/60">
              <td className="sticky left-0 z-10 bg-card px-3 py-2">
                <button type="button" onClick={() => onOpen(e.id)} className="text-left hover:underline">
                  <div className="font-medium">{e.name}</div>
                  <div className="text-xs text-muted-foreground">{e.employeeId}</div>
                </button>
              </td>
              {e.records.map((r) => (
                <td key={r.date} className="px-1.5 py-2 text-center">
                  <span
                    title={`${DAY_STATUS_LABEL[r.status]}${r.checkIn ? ` · in ${istTime(r.checkIn)}` : ""}${r.remarks.length ? ` · ${r.remarks.join(", ")}` : ""}`}
                    className={cn(
                      "inline-flex size-6 items-center justify-center rounded text-xs font-medium",
                      STATUS_BADGE[r.status],
                      data.filters.status !== "ALL" && r.status !== data.filters.status && "opacity-30",
                    )}
                  >
                    {DAY_STATUS_CODE[r.status] || "·"}
                  </span>
                </td>
              ))}
              <td className="px-2 text-right tabular-nums">{e.totals.present}</td>
              <td className="px-2 text-right tabular-nums">{e.totals.absent}</td>
              <td className="px-2 text-right font-medium tabular-nums">{pct(e.totals.attendancePct)}</td>
              <td className="px-2 pr-3 text-right tabular-nums" title={`${e.totals.calls} calls`}>{formatHours(e.totals.talkTimeSec * 1000)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
        P = Present · A = Absent · – = today, not yet recorded (before {data.policy.cutoff} IST) · · = outside the reporting period (before joining or before attendance tracking began).
      </p>
    </div>
  );
}

/** "day": every employee on one date. "history": one employee, one row per date. */
function RecordsTable({ mode, data, onOpen }: { mode: "day" | "history"; data: AttendanceRecords; onOpen: (id: string) => void }) {
  const rows: { id: string; name: string; employeeId: string; r: AttendanceDayRecord }[] =
    mode === "day"
      ? data.employees.map((e) => ({ id: e.id, name: e.name, employeeId: e.employeeId, r: e.records[0]! }))
      : data.employees.flatMap((e) => [...e.records].reverse().map((r) => ({ id: e.id, name: e.name, employeeId: e.employeeId, r })));
  const shown = rows.filter((x) => x.r.status !== "NOT_JOINED" && x.r.status !== "NOT_TRACKED" && (data.filters.status === "ALL" || x.r.status === data.filters.status));
  // Durations and counts are right-aligned so their digits line up; everything else reads left to right.
  const head: { label: string; right?: boolean }[] = [
    { label: "Employee ID" },
    { label: "Employee" },
    { label: "Date" },
    { label: "Check-In" },
    { label: "Check-Out" },
    { label: "Working", right: true },
    { label: "Productive", right: true },
    { label: "Calls", right: true },
    { label: "Talk Time", right: true },
    { label: "Status" },
    { label: "Remarks" },
  ];
  const cell = "px-3 py-2.5 align-middle whitespace-nowrap";
  const num = `${cell} text-right tabular-nums`;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/60 text-xs text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h.label} className={cn("px-3 py-2 font-medium whitespace-nowrap", h.right ? "text-right" : "text-left")}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map(({ id, name, employeeId, r }) => (
            <tr key={`${id}-${r.date}`} className="border-t border-border/60 hover:bg-muted/30">
              <td className={cn(cell, "text-muted-foreground")}>{employeeId}</td>
              <td className={cell}>
                <button type="button" onClick={() => onOpen(id)} className="text-left font-medium hover:underline">
                  {name}
                </button>
              </td>
              <td className={cell}>
                {weekday(r.date)} {dayLabel(r.date)}
              </td>
              <td className={cn(cell, "tabular-nums")}>{istTime(r.checkIn) || "—"}</td>
              <td className={cn(cell, "tabular-nums")}>{r.stillWorking ? "Working" : istTime(r.checkOut) || "—"}</td>
              <td className={num}>{r.checkIn ? formatHours(r.workingMs) : "—"}</td>
              <td className={num}>{r.checkIn ? formatHours(r.productiveMs) : "—"}</td>
              <td className={num}>{r.calls || "—"}</td>
              <td className={num}>{r.talkTimeSec ? formatHours(r.talkTimeSec * 1000) : "—"}</td>
              <td className={cell}>
                <StatusBadge status={r.status} />
              </td>
              <td className="min-w-48 px-3 py-2.5 align-middle text-xs text-muted-foreground">{r.remarks.join(" · ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 ? <EmptyState>No attendance matches these filters.</EmptyState> : null}
    </div>
  );
}
