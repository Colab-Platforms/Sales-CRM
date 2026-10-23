"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronLeft, ChevronRight, Clock, Download, Percent, UserCheck, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { KpiCard } from "@/components/manager-dashboard/kpi-card";
import { EmptyState, Panel, Segmented } from "@/components/manager-dashboard/panel";
import { getErrorMessage } from "@/lib/api-client/client";
import { attendanceApi } from "@/lib/api-client/endpoints/attendance.api";
import { attendanceRecordsQueryOptions } from "@/lib/api-client/queries/attendance.queries";
import type { AttendanceDayRecord, AttendanceRecords, DayStatus } from "@/lib/api-client/types/attendance.types";
import { DAY_STATUS_LABEL, exportAttendanceCsv, exportAttendanceXlsx, istTime } from "@/lib/attendance-export";
import { formatHours } from "@/lib/attendance";
import { istToday, monthEnd, monthStart, shiftDay, weekStart } from "@/lib/date-presets";
import { formatDay } from "@/lib/manager-analytics";
import { cn } from "@/lib/utils";
import { DAY_STATUS_STYLE, DayStatusBadge } from "./day-status-badge";

// Monthly attendance calendar built on the same records as the Attendance report (WorkSession clock-ins,
// statuses from attendance.records.ts on the server). Read-only: nothing here creates or edits attendance.
// "team" = a manager's / admin's authorised employees (all, or one); "self" = the signed-in salesperson.

type Period = "day" | "week" | "month" | "custom";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const monthTitle = (ymd: string) =>
  new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const addMonths = (first: string, n: number) => {
  const [y, m] = first.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};
const minDay = (a: string, b: string) => (a < b ? a : b);

export function AttendanceCalendar({ scope }: { scope: "team" | "self" }) {
  const today = istToday();
  const [month, setMonth] = useState(() => monthStart(today));
  const [userId, setUserId] = useState("");
  const [selected, setSelected] = useState(today);
  const [period, setPeriod] = useState<Period>("month");
  const [custom, setCustom] = useState({ from: shiftDay(today, -29), to: today });

  // Calendar data: the visible month up to today (future days have no attendance yet).
  const monthFrom = month;
  const monthTo = minDay(monthEnd(month), today);
  const monthInFuture = monthFrom > today;
  const calendarQuery = { from: monthFrom, to: monthInFuture ? monthFrom : monthTo, status: "ALL" as const, page: 1, pageSize: 1000, userId: userId || undefined };
  const cal = useQuery({ ...attendanceRecordsQueryOptions(calendarQuery), enabled: !monthInFuture });

  // Summary data: the chosen period (day / its week / the visible month / a custom range), never past today.
  const summaryRange = (() => {
    if (period === "day") return { from: selected, to: selected };
    if (period === "week") return { from: weekStart(selected), to: minDay(shiftDay(weekStart(selected), 6), today) };
    if (period === "month") return { from: monthFrom, to: monthTo };
    return { from: custom.from, to: custom.to };
  })();
  const summaryError =
    period === "custom" && (!custom.from || !custom.to || custom.from > custom.to)
      ? "Pick a valid From and To date."
      : summaryRange.from > today
        ? "That period has not started yet."
        : null;
  const summaryQuery = { ...summaryRange, status: "ALL" as const, page: 1, pageSize: 1000, userId: userId || undefined };
  const sum = useQuery({ ...attendanceRecordsQueryOptions(summaryQuery), enabled: !summaryError });

  const people = cal.data?.team ?? sum.data?.team ?? [];
  const single = scope === "self" || Boolean(userId);
  const personName = scope === "self" ? (cal.data?.employees[0]?.name ?? "My attendance") : userId ? (people.find((p) => p.id === userId)?.name ?? "Employee") : "All employees";

  const [exporting, setExporting] = useState(false);
  const runExport = async (kind: "csv" | "xlsx") => {
    if (summaryError) return;
    setExporting(true);
    try {
      const data = await attendanceApi.getRecords(summaryQuery);
      const name = `attendance-${scope === "self" ? "mine" : userId ? "employee" : "team"}-${data.range.from}_${data.range.to}`;
      if (kind === "csv") exportAttendanceCsv(`${name}.csv`, data, personName);
      else await exportAttendanceXlsx(`${name}.xlsx`, data, personName);
    } catch (e) {
      toast.error(getErrorMessage(e, "The export could not be created."));
    } finally {
      setExporting(false);
    }
  };

  const goMonth = (n: number) => setMonth((m) => addMonths(m, n));
  const pick = (d: string) => {
    setSelected(d);
    if (period === "custom") setPeriod("day");
  };

  return (
    <div className="space-y-5">
      {/* ---- controls ---- */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" aria-label="Previous month" onClick={() => goMonth(-1)}>
            <ChevronLeft />
          </Button>
          <h2 className="min-w-40 text-center text-base font-semibold">{monthTitle(month)}</h2>
          <Button variant="outline" size="icon-sm" aria-label="Next month" onClick={() => goMonth(1)} disabled={addMonths(month, 1) > today}>
            <ChevronRight />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMonth(monthStart(today));
              setSelected(today);
            }}
          >
            Today
          </Button>
        </div>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Date
          <Input
            type="date"
            value={selected}
            max={today}
            onChange={(e) => {
              if (!e.target.value) return;
              setSelected(e.target.value);
              setMonth(monthStart(e.target.value));
            }}
            className="w-40"
          />
        </label>
        {scope === "team" ? (
          <label className="grid gap-1 text-xs text-muted-foreground">
            Employee
            <NativeSelect value={userId} onChange={(e) => setUserId(e.target.value)} wrapperClassName="w-52" aria-label="Employee">
              <option value="">All employees</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : null}
      </div>

      {/* ---- calendar ---- */}
      <Panel
        title={`${personName} · ${monthTitle(month)}`}
        description={single ? "Each day shows Present or Absent and the first clock-in. Click a day for details." : "Each day shows how many employees were present and absent. Click a day for everyone's details."}
        bodyClassName="p-2 sm:p-4"
      >
        {monthInFuture ? (
          <EmptyState>This month has not started yet.</EmptyState>
        ) : cal.isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : cal.error || !cal.data ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            {getErrorMessage(cal.error, "Could not load attendance.")}
          </p>
        ) : (
          <MonthGrid month={month} today={today} data={cal.data} single={single} selected={selected} onPick={pick} />
        )}
        <Legend />
      </Panel>

      {/* ---- day details ---- */}
      {!monthInFuture && cal.data ? <DayDetails date={selected} data={cal.data} single={single} today={today} /> : null}

      {/* ---- summary ---- */}
      <Panel
        title="Summary"
        description={`${period === "day" ? "Selected day" : period === "week" ? "Week of the selected day (Mon–Sun)" : period === "month" ? "Visible month" : "Custom range"} · ${formatDay(summaryRange.from)} – ${formatDay(summaryRange.to)}`}
        actions={
          <>
            <Segmented
              label="Summary period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: "day", label: "Day" },
                { value: "week", label: "Week" },
                { value: "month", label: "Month" },
                { value: "custom", label: "Custom" },
              ]}
            />
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={exporting || Boolean(summaryError)} />}>
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
          </>
        }
      >
        {period === "custom" ? (
          <div className="mb-4 flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs text-muted-foreground">
              From
              <Input type="date" value={custom.from} max={custom.to || today} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="w-40" />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              To
              <Input type="date" value={custom.to} min={custom.from || undefined} max={today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="w-40" />
            </label>
          </div>
        ) : null}
        {summaryError ? (
          <p className="text-sm text-destructive">{summaryError}</p>
        ) : sum.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : sum.error || !sum.data ? (
          <p role="alert" className="text-sm text-destructive">
            {getErrorMessage(sum.error, "Could not load the summary.")}
          </p>
        ) : (
          <SummaryCards data={sum.data} single={single} />
        )}
      </Panel>
    </div>
  );
}

function MonthGrid({
  month,
  today,
  data,
  single,
  selected,
  onPick,
}: {
  month: string;
  today: string;
  data: AttendanceRecords;
  single: boolean;
  selected: string;
  onPick: (d: string) => void;
}) {
  const first = weekStart(month);
  const last = monthEnd(month);
  const weeks: string[][] = [];
  for (let d = first; d <= last; d = shiftDay(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => shiftDay(d, i)));
  const byDate = new Map<string, AttendanceDayRecord[]>();
  for (const e of data.employees) for (const r of e.records) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const counted = (rs: AttendanceDayRecord[]) => {
    const c = { PRESENT: 0, ABSENT: 0, PENDING: 0 };
    for (const r of rs) if (r.status in c) c[r.status as keyof typeof c] += 1;
    return c;
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[440px] table-fixed border-separate border-spacing-0.5 sm:border-spacing-1">
        <thead>
          <tr>
            {WEEKDAYS.map((w) => (
              <th key={w} className="py-1 text-center text-xs font-medium text-muted-foreground">
                {w}
              </th>
            ))}
            <th className="w-12 py-1 text-center text-xs font-medium text-muted-foreground sm:w-20">Week</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => {
            const inWeek = week.filter((d) => d.startsWith(month.slice(0, 7)) && d <= today).flatMap((d) => byDate.get(d) ?? []);
            const c = counted(inWeek);
            const expected = c.PRESENT + c.ABSENT;
            return (
              <tr key={week[0]}>
                {week.map((d) => {
                  const inMonth = d.startsWith(month.slice(0, 7));
                  const future = d > today;
                  const rs = byDate.get(d) ?? [];
                  const isSel = d === selected;
                  if (!inMonth) return <td key={d} />;
                  // Days before joining / before tracking are outside the reporting period: neutral, no status.
                  const rec = single && rs[0] && rs[0].status !== "NOT_JOINED" && rs[0].status !== "NOT_TRACKED" ? rs[0] : undefined;
                  const k = counted(rs);
                  return (
                    <td key={d} className="align-top">
                      <button
                        type="button"
                        disabled={future}
                        onClick={() => onPick(d)}
                        aria-pressed={isSel}
                        aria-label={`${formatDay(d, "long")}${rec ? `: ${DAY_STATUS_LABEL[rec.status]}` : ""}`}
                        className={cn(
                          "flex min-h-16 w-full flex-col items-start gap-0.5 rounded-md border p-1 text-left transition-colors sm:min-h-24 sm:gap-1 sm:p-1.5",
                          future ? "cursor-default border-dashed border-border/60 opacity-50" : "border-border hover:border-primary/50",
                          rec ? DAY_STATUS_STYLE[rec.status] : "bg-card",
                          isSel && "ring-2 ring-primary ring-offset-1 ring-offset-background",
                        )}
                      >
                        <span className={cn("text-xs font-semibold", d === today && "rounded bg-primary px-1 text-primary-foreground")}>{Number(d.slice(8))}</span>
                        {future ? null : single ? (
                          rec ? (
                            <>
                              <span className="text-[11px] leading-tight font-medium">{DAY_STATUS_LABEL[rec.status]}</span>
                              {rec.checkIn ? <span className="hidden text-[10px] tabular-nums opacity-80 sm:block">in {istTime(rec.checkIn)}</span> : null}
                            </>
                          ) : null
                        ) : rs.length ? (
                          <span className="flex flex-wrap gap-0.5 text-[10px] font-medium">
                            <CountChip status="PRESENT" n={k.PRESENT} label="P" />
                            <CountChip status="ABSENT" n={k.ABSENT} label="A" />
                            {k.PENDING ? <CountChip status="PENDING" n={k.PENDING} label="–" /> : null}
                          </span>
                        ) : null}
                      </button>
                    </td>
                  );
                })}
                <td className="text-center align-middle text-xs text-muted-foreground tabular-nums" title="Present of eligible working days this week">
                  {expected ? (
                    <>
                      <span className="font-semibold text-foreground">{Math.round((c.PRESENT / expected) * 100)}%</span>
                      <br />
                      {c.PRESENT}/{expected}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CountChip({ status, n, label }: { status: DayStatus; n: number; label: string }) {
  if (!n) return null;
  return (
    <span className={cn("rounded px-1 tabular-nums", DAY_STATUS_STYLE[status])} title={`${n} ${DAY_STATUS_LABEL[status].toLowerCase()}`}>
      {label} {n}
    </span>
  );
}

function Legend() {
  const items: DayStatus[] = ["PRESENT", "ABSENT", "PENDING"];
  return (
    <div className="mt-3 space-y-1 px-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-2">
        {items.map((s) => (
          <DayStatusBadge key={s} status={s} />
        ))}
      </div>
      <p>
        Present = a clock-in that day · Absent = no clock-in on a working day (today, only once the attendance cut-off has passed) · Not Yet Recorded = today, before the cut-off.
        Days before an employee joined or before tracking began are outside the reporting period and left blank. No weekly-off, holiday or leave records exist in this CRM, so every day is a working day.
      </p>
    </div>
  );
}

function DayDetails({ date, data, single, today }: { date: string; data: AttendanceRecords; single: boolean; today: string }) {
  const rows = data.employees
    .map((e) => ({ e, r: e.records.find((r) => r.date === date) }))
    .filter((x): x is { e: AttendanceRecords["employees"][number]; r: AttendanceDayRecord } => Boolean(x.r));
  const title = `${formatDay(date, "long")}${date === today ? " (today)" : ""}`;
  if (rows.length === 0) {
    return (
      <Panel title={title}>
        <EmptyState>No attendance for this date in the selected month.</EmptyState>
      </Panel>
    );
  }
  if (single) {
    const { e, r } = rows[0]!;
    const items: [string, string][] = [
      ["Employee", `${e.name} (${e.employeeId})`],
      ["Date", formatDay(date, "long")],
      ["Status", DAY_STATUS_LABEL[r.status]],
      ["Check-in", istTime(r.checkIn) || "—"],
      ["Check-out", r.stillWorking ? "Still working" : istTime(r.checkOut) || "—"],
      ["Break time", r.checkIn ? formatHours(r.breakMs) : "—"],
      ["Working hours", r.checkIn ? formatHours(r.workingMs) : "—"],
      ["Productive time", r.checkIn ? formatHours(r.productiveMs) : "—"],
      ["Sessions", String(r.sessions)],
      ["Remarks", r.remarks.join(" · ") || "—"],
    ];
    return (
      <Panel title={title} description="From the clock-in records. Attendance corrections are not recorded in this CRM, so there is no correction history.">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className={cn("text-sm font-medium", k === "Status" && "mt-0.5")}>{k === "Status" ? <DayStatusBadge status={r.status} /> : v}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    );
  }
  return (
    <Panel title={title} description="Everyone's attendance on this date." bodyClassName="p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Employee ID</TableHead>
            <TableHead>Employee</TableHead>
            <TableHead>Check-in</TableHead>
            <TableHead>Check-out</TableHead>
            <TableHead className="text-right">Break</TableHead>
            <TableHead className="text-right">Working</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Remarks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows
            .filter(({ r }) => r.status !== "NOT_JOINED" && r.status !== "NOT_TRACKED")
            .map(({ e, r }) => (
              <TableRow key={e.id}>
                <TableCell className="text-muted-foreground">{e.employeeId}</TableCell>
                <TableCell className="font-medium">{e.name}</TableCell>
                <TableCell className="tabular-nums">{istTime(r.checkIn) || "—"}</TableCell>
                <TableCell className="tabular-nums">{r.stillWorking ? "Working" : istTime(r.checkOut) || "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{r.checkIn ? formatHours(r.breakMs) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{r.checkIn ? formatHours(r.workingMs) : "—"}</TableCell>
                <TableCell>
                  <DayStatusBadge status={r.status} />
                </TableCell>
                <TableCell className="min-w-48 text-xs whitespace-normal text-muted-foreground">{r.remarks.join(" · ") || "—"}</TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

function SummaryCards({ data, single }: { data: AttendanceRecords; single: boolean }) {
  const s = data.summary;
  const unit = single ? "days" : data.range.days.length > 1 ? "employee-days" : "employees";
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiCard label="Present" tone="emerald" icon={UserCheck} value={String(s.present)} lines={[{ text: unit }]} />
      <KpiCard label="Absent" tone="red" icon={UserX} value={String(s.absent)} lines={[{ text: unit }]} />
      <KpiCard
        label="Attendance %"
        tone="violet"
        icon={Percent}
        value={s.attendancePct === null ? "—" : `${s.attendancePct.toFixed(1)}%`}
        lines={[{ text: s.expected ? `${s.attended} of ${s.expected} working ${single ? "days" : unit}` : "Nothing expected yet" }]}
      />
      <KpiCard label="Working hours" tone="blue" icon={Clock} value={formatHours(s.workingMs)} lines={[{ text: `${formatHours(s.productiveMs)} productive` }]} />
    </div>
  );
}
