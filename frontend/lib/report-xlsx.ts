import type { ManagerAnalytics } from "@/lib/api-client/types/manager-analytics.types";
import {
  CALL_STATUS_LABELS,
  LEAD_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  PAYMENT_MODE_LABELS,
  callsPerProductiveHour,
  conversionRate,
  formatDuration,
  formatMs,
  type DashboardFilters,
} from "@/lib/manager-analytics";

export type Cell = string | number;
export interface SheetSpec {
  name: string;
  header: string[];
  rows: Cell[][];
  /** Column indexes holding rupee amounts, shown with thousands separators and 2 decimals. */
  money?: number[];
  /** Optional bold "Total" row written after the data rows. */
  totals?: Cell[];
}

const round = (n: number, digits: number) => Number(n.toFixed(digits));
const aov = (revenue: number, orders: number) => (orders > 0 ? round(revenue / orders, 2) : 0);

/**
 * Bottom "Total" row of the Salesperson Performance sheet. Counts, durations and money are added up;
 * rates are worked out from those totals (adding up each person's % or average would give a meaningless number).
 */
function performanceTotals(data: ManagerAnalytics): Cell[] {
  const ps = data.salespeople;
  const sum = (pick: (p: (typeof ps)[number]) => number) => ps.reduce((a, p) => a + pick(p), 0);
  const leads = sum((p) => p.leads);
  const converted = sum((p) => p.converted);
  const calls = sum((p) => p.calls);
  const productiveMs = sum((p) => p.productiveMs);
  const orders = sum((p) => p.orders);
  const revenue = round(sum((p) => p.revenue), 2);
  return [
    "Total", leads, sum((p) => p.contacted), sum((p) => p.interested), converted, round(conversionRate({ leads, converted }), 2),
    calls, sum((p) => p.connected), sum((p) => p.notConnected), sum((p) => p.failed),
    sum((p) => p.uniqueLeads), formatDuration(sum((p) => p.talkTimeSec)), formatMs(productiveMs), round(callsPerProductiveHour(calls, productiveMs), 1),
    orders, sum((p) => p.codOrders), sum((p) => p.prepaidOrders), revenue, round(sum((p) => p.codRevenue), 2), round(sum((p) => p.prepaidRevenue), 2), aov(revenue, orders),
  ];
}

function sheets(data: ManagerAnalytics, filters?: DashboardFilters): SheetSpec[] {
  const k = data.kpis;
  const person = filters?.salespersonId ? (data.team.find((p) => p.id === filters.salespersonId)?.name ?? "") : "All salespeople";

  return [
    {
      // Columns and order match the team's existing report sheet; sales columns follow on the right.
      name: "Salesperson Performance",
      header: [
        "Salesperson", "Leads", "Contacted", "Interested", "Converted", "Conversion %", "Calls", "Connected", "Not Connected", "Failed",
        "Unique Leads Called", "Talk Time", "Productive Time", "Calls / Productive Hour",
        "Orders", "COD Orders", "Prepaid Orders", "Revenue", "COD Revenue", "Prepaid Revenue", "Avg Order Value",
      ],
      rows: data.salespeople.map((p) => [
        p.name, p.leads, p.contacted, p.interested, p.converted, round(conversionRate(p), 2), p.calls, p.connected, p.notConnected, p.failed,
        p.uniqueLeads, formatDuration(p.talkTimeSec), formatMs(p.productiveMs), round(callsPerProductiveHour(p.calls, p.productiveMs), 1),
        p.orders, p.codOrders, p.prepaidOrders, p.revenue, p.codRevenue, p.prepaidRevenue, aov(p.revenue, p.orders),
      ]),
      money: [17, 18, 19, 20],
      totals: performanceTotals(data),
    },
    {
      name: "Sales Summary",
      header: ["Total Orders", "Average Order Value", "Revenue", "COD Orders", "Prepaid Orders", "COD Revenue", "Prepaid Revenue", "Previous Period Orders", "Previous Period Revenue"],
      rows: [[k.orders, aov(k.revenue, k.orders), k.revenue, k.codOrders, k.prepaidOrders, k.codRevenue, k.prepaidRevenue, k.previousOrders, k.previousRevenue]],
      money: [1, 2, 5, 6, 8],
    },
    {
      name: "Products Sold",
      header: ["Product", "SKU", "Orders", "Units", "COD Orders", "Prepaid Orders", "Revenue", "Top Salesperson", "Top Salesperson Units"],
      rows: data.products.map((p) => [
        p.name, p.sku ?? "", p.orders, p.units, p.codOrders, p.prepaidOrders, p.revenue, p.topSalesperson?.name ?? "", p.topSalesperson?.units ?? 0,
      ]),
      money: [6],
    },
    {
      name: "Daily",
      header: ["Date", "Calls", "Connected", "Not Connected", "Failed", "Unique Leads", "Talk Time", "Productive Time", "Orders", "Revenue", ...data.salespeople.map((p) => `${p.name} Calls`)],
      rows: data.daily.map((d) => [
        d.date, d.calls, d.connected, d.notConnected, d.failed, d.uniqueLeads, formatDuration(d.talkTimeSec), formatMs(d.productiveMs), d.orders, d.revenue,
        ...data.salespeople.map((p) => d.bySalesperson[p.id]?.calls ?? 0),
      ]),
      money: [9],
    },
    {
      name: "Report Info",
      header: ["Field", "Value"],
      rows: [
        ["Report", "Sales Report"],
        ["Period", `${data.range.from} to ${data.range.to} (${data.range.days} days)`],
        ["Salesperson", person],
        ...(filters
          ? [
              ["Payment Method", PAYMENT_MODE_LABELS[filters.paymentMode]],
              ["Order Status", ORDER_STATUS_LABELS[filters.orderStatus]],
              ["Calls", CALL_STATUS_LABELS[filters.callStatus]],
              ["Leads", LEAD_STATUS_LABELS[filters.leadStatus]],
            ]
          : []),
        ["Generated", new Date().toLocaleString("en-IN")],
        ["Note", "Product revenue is line totals, so it excludes shipping and order-level discounts."],
      ],
    },
  ];
}

const THIN = { style: "thin" as const, color: { argb: "FF000000" } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/** Builds the team report as a formatted .xlsx and downloads it. */
export async function exportReportXlsx(filename: string, data: ManagerAnalytics, filters?: DashboardFilters) {
  await downloadXlsx(filename, sheets(data, filters));
}

/** Writes sheets as a formatted .xlsx (bold yellow header, bordered cells, fitted columns) and downloads it. */
export async function downloadXlsx(filename: string, specs: SheetSpec[]) {
  // Loaded on click so the spreadsheet library never weighs on the page bundle.
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  for (const spec of specs) {
    const ws = wb.addWorksheet(spec.name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRow(spec.header);
    spec.rows.forEach((r) => ws.addRow(r));
    if (spec.totals && spec.rows.length > 0) {
      const total = ws.addRow(spec.totals);
      total.font = { bold: true };
      total.eachCell((c) => {
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
      });
    }

    const header = ws.getRow(1);
    header.font = { bold: true };
    header.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
    });

    ws.eachRow((row) => row.eachCell({ includeEmpty: true }, (c) => (c.border = BORDER)));
    for (const i of spec.money ?? []) ws.getColumn(i + 1).numFmt = "#,##0.00";
    // Keep the header's number format plain text even in money columns.
    header.eachCell((c) => (c.numFmt = "@"));

    ws.columns.forEach((col, i) => {
      const longest = Math.max(spec.header[i]?.length ?? 0, ...[...spec.rows, spec.totals ?? []].map((r) => String(r[i] ?? "").length));
      col.width = Math.min(Math.max(longest + 2, 6), 60);
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
