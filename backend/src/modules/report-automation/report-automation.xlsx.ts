import ExcelJS from "exceljs";
import { offsetLabel, normalizeOptions, type DailyReportData, type ReportOptions } from "./report-automation.report.js";

// The Excel attachment: a real .xlsx (OOXML zip) built from the SAME DailyReportData as the WhatsApp text, so the date, timezone, filters and numbers cannot differ.
// No "Order Details" sheet: the report's order figures come from the Sales & Revenue analytics (orders credited by confirmation, revenue by that definition), which is only available as
// aggregates per telecaller. An order-level list built from a different query could disagree with those totals, and would put customer data in the file, so it is deliberately left out.

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const reportFilename = (date: string, from?: string): string => (from && from !== date ? `AyushWellness_Daily_Report_${from}_to_${date}.xlsx` : `AyushWellness_Daily_Report_${date}.xlsx`);

/** A cell that starts with = + - @ (or a control character) would be read as a formula by Excel / Sheets: store it as plain text with a leading apostrophe-free guard. */
export const safeCell = (value: string): string => {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  return /^[=+\-@\t\r]/.test(clean) ? `'${clean}` : clean;
};

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" } };
const MONEY_FMT = '"₹"#,##0.00';
const PCT_FMT = "0.0%";
const DURATION_FMT = "[h]:mm:ss";
const secondsToDay = (sec: number) => sec / 86_400;

function styleHeader(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  row.height = 28;
}

export async function buildReportXlsx(data: DailyReportData, rawOptions: ReportOptions): Promise<Buffer> {
  const options = normalizeOptions(rawOptions);
  const wb = new ExcelJS.Workbook();
  wb.creator = "AyushWellness CRM";
  wb.created = new Date(`${data.to}T00:00:00.000Z`); // deterministic: the same report is the same file

  // ---- Sheet 1: Team Summary
  const summary = wb.addWorksheet("Team Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  summary.columns = [{ header: "Metric", key: "metric", width: 34 }, { header: "Value", key: "value", width: 24 }];
  styleHeader(summary.getRow(1));
  const t = data.team;
  const add = (metric: string, value: string | number | null, fmt?: string) => {
    const row = summary.addRow({ metric, value: typeof value === "string" ? safeCell(value) : value });
    if (fmt) row.getCell(2).numFmt = fmt;
    row.getCell(2).alignment = { horizontal: "right" };
  };
  if (data.from === data.to) add("Report date", data.to);
  else {
    add("Report period start", data.from);
    add("Report period end", data.to);
  }
  add("Timezone", `${data.timezone} (${offsetLabel(data.offsetMinutes)})`);
  add("Telecallers in report", t.telecallers);
  if (options.sales) {
    add("Orders", t.orders);
    add("Revenue", t.revenue, MONEY_FMT);
    add("Cancelled orders", t.cancelledOrders);
  }
  if (options.leads) {
    add("Leads handled", t.leads);
    add("Converted leads", t.converted);
    add("Conversion rate", t.conversionPct === null ? "n/a" : t.conversionPct / 100, PCT_FMT);
  }
  if (options.calls) {
    add("Calls", t.calls);
    add("Connected calls", t.connected);
    add("Talk time", secondsToDay(t.talkTimeSec), DURATION_FMT);
  }
  if (options.followUps) add("Pending follow-ups", t.pendingFollowUps);

  // ---- Sheet 2: Telecaller Performance
  const sheet = wb.addWorksheet("Telecaller Performance", { views: [{ state: "frozen", ySplit: 1, xSplit: 1 }] });
  type Col = { header: string; key: string; width: number; fmt?: string; on: boolean };
  const cols: Col[] = [
    { header: "Telecaller", key: "name", width: 28, on: true },
    { header: "Orders", key: "orders", width: 10, on: options.sales },
    { header: "Revenue", key: "revenue", width: 16, fmt: MONEY_FMT, on: options.sales },
    { header: "Cancelled orders", key: "cancelledOrders", width: 12, on: options.sales },
    { header: "Leads handled", key: "leads", width: 12, on: options.leads },
    { header: "Converted leads", key: "converted", width: 12, on: options.leads },
    { header: "Conversion rate", key: "conversionPct", width: 12, fmt: PCT_FMT, on: options.leads },
    { header: "Total calls", key: "calls", width: 10, on: options.calls },
    { header: "Connected calls", key: "connected", width: 12, on: options.calls },
    { header: "Talk time (h:mm:ss)", key: "talkTimeSec", width: 14, fmt: DURATION_FMT, on: options.calls },
    { header: "Pending follow-ups", key: "pendingFollowUps", width: 12, on: options.followUps },
  ].filter((c) => c.on);
  sheet.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeader(sheet.getRow(1));
  for (const p of data.people) {
    const values: Record<string, string | number | null> = {
      name: safeCell(p.name),
      orders: p.orders,
      revenue: p.revenue,
      cancelledOrders: p.cancelledOrders,
      leads: p.leads,
      converted: p.converted,
      conversionPct: p.conversionPct === null ? "n/a" : p.conversionPct / 100,
      calls: p.calls,
      connected: p.connected,
      talkTimeSec: secondsToDay(p.talkTimeSec),
      pendingFollowUps: p.pendingFollowUps,
    };
    const row = sheet.addRow(Object.fromEntries(cols.map((c) => [c.key, values[c.key]])));
    cols.forEach((c, i) => {
      if (c.fmt) row.getCell(i + 1).numFmt = c.fmt;
      if (i > 0) row.getCell(i + 1).alignment = { horizontal: "right" };
    });
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, data.people.length + 1), column: cols.length } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
