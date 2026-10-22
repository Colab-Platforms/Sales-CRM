import type { AttendanceDayRecord, AttendanceRecords, DayStatus } from "@/lib/api-client/types/attendance.types";
import { downloadXlsx, type Cell, type SheetSpec } from "@/lib/report-xlsx";

export const DAY_STATUS_LABEL: Record<DayStatus, string> = {
  PRESENT: "Present",
  LATE: "Late",
  ABSENT: "Absent",
  PENDING: "Not in yet",
  NOT_JOINED: "Not joined",
  NOT_TRACKED: "Not tracked",
};
/** One letter per cell in the matrix. */
export const DAY_STATUS_CODE: Record<DayStatus, string> = { PRESENT: "P", LATE: "L", ABSENT: "A", PENDING: "-", NOT_JOINED: "", NOT_TRACKED: "" };

const STATUS_FILTER_LABEL = { ALL: "All", PRESENT: "Present", LATE: "Late", ABSENT: "Absent" } as const;

/** "HH:MM" in India time (the report zone), or "" when there is no time. */
export function istTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(11, 16);
}

/** Hours with 2 decimals, for spreadsheets (sums cleanly). */
const hours = (ms: number) => Number((ms / 3_600_000).toFixed(2));

function recordRow(name: string, employeeId: string, r: AttendanceDayRecord): Cell[] {
  return [
    employeeId, name, r.date, DAY_STATUS_LABEL[r.status], istTime(r.checkIn),
    r.stillWorking ? "Still working" : istTime(r.checkOut), hours(r.workingMs), hours(r.productiveMs), hours(r.breakMs),
    r.calls, hours(r.talkTimeSec * 1000), r.lateByMs > 0 ? Math.round(r.lateByMs / 60_000) : "", r.remarks.join("; "),
  ];
}

const RECORD_HEADER = [
  "Employee ID", "Employee Name", "Date", "Status", "Check-In (IST)", "Check-Out (IST)",
  "Working Hours", "Productive Hours", "Break Hours", "Calls", "Talk Time (hours)", "Late By (min)", "Remarks",
];

function sheets(data: AttendanceRecords, employeeName: string): SheetSpec[] {
  const status = data.filters.status;
  // Date-wise rows follow the status filter; pre-joining days are not attendance and are left out.
  const records = data.employees.flatMap((e) =>
    e.records
      .filter((r) => r.status !== "NOT_JOINED" && r.status !== "NOT_TRACKED" && (status === "ALL" || r.status === status))
      .map((r) => recordRow(e.name, e.employeeId, r)),
  );
  const s = data.summary;
  return [
    {
      name: "Attendance Matrix",
      header: ["Employee ID", "Employee Name", ...data.range.days, "Present", "Late", "Absent", "Attendance %", "Calls", "Talk Time (hours)", "Working Hours"],
      rows: data.employees.map((e) => [
        e.employeeId, e.name, ...e.records.map((r) => DAY_STATUS_CODE[r.status]),
        e.totals.present, e.totals.late, e.totals.absent, e.totals.attendancePct ?? "",
        e.totals.calls, hours(e.totals.talkTimeSec * 1000), hours(e.totals.workingMs),
      ]),
    },
    { name: "Daily Records", header: RECORD_HEADER, rows: records },
    {
      name: "Daily Summary",
      header: ["Date", "Present", "Late", "Absent", "Expected", "Attendance %"],
      rows: data.daily.map((d) => [d.date, d.present, d.late, d.absent, d.expected, d.attendancePct ?? ""]),
    },
    {
      name: "Report Info",
      header: ["Field", "Value"],
      rows: [
        ["Report", "Attendance Report"],
        ["Period", `${data.range.from} to ${data.range.to} (${data.range.days.length} days)`],
        ["Employee", employeeName],
        ["Status filter", STATUS_FILTER_LABEL[status]],
        ["Employees", s.totalEmployees],
        ["Present days", s.present],
        ["Late days", s.late],
        ["Absent days", s.absent],
        ["Attendance %", s.attendancePct ?? ""],
        ["Calls", s.calls],
        ["Talk Time (hours)", hours(s.talkTimeSec * 1000)],
        ["Talk time", "Duration of connected calls, by the day each call started (same as the sales reports)"],
        ["Late rule", `First clock-in after ${data.policy.lateAfter} IST`],
        ["Codes", "P = Present, L = Late, A = Absent, - = not clocked in yet today, blank = before joining or before attendance tracking began"],
        ["Tracking began", data.policy.trackingStartedOn ?? "No attendance recorded yet"],
        ["Not tracked", "Half-day, leave, holidays and weekly offs (every day is a working day)"],
        ["Generated", new Date().toLocaleString("en-IN")],
      ],
    },
  ];
}

export async function exportAttendanceXlsx(filename: string, data: AttendanceRecords, employeeName: string) {
  await downloadXlsx(filename, sheets(data, employeeName));
}

/** A CSV cell; text a spreadsheet would run as a formula is prefixed with an apostrophe. */
function csvCell(v: Cell): string {
  if (typeof v === "number") return String(v);
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Date-wise attendance (one row per employee per day) as UTF-8 CSV with a BOM, so Excel opens it correctly. */
export function exportAttendanceCsv(filename: string, data: AttendanceRecords, employeeName: string) {
  const rows = sheets(data, employeeName)[1]!;
  const text = "﻿" + [rows.header, ...rows.rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
