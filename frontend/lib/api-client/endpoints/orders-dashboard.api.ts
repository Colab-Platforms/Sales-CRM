import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { AbandonedChartResult, AbandonedQuery, AbandonedResult, ChartInterval, DashboardRangeKind, OrdersChartResult, OrdersDashboardQuery, OrdersDashboardResult } from "../types/orders-dashboard.types";

// Admin / Manager only on the server (403 for everyone else); every call is authenticated like the rest of the CRM.
const params = (q: Partial<OrdersDashboardQuery> | Partial<AbandonedQuery>) => {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") out[k] = v as string | number;
  if (q.range !== "custom") {
    delete out.from;
    delete out.to;
  }
  // without a clicked card only the cards are wanted: nothing else is sent, so no order rows are read
  if (!q.metric) for (const k of ["section", "search", "paymentStatus", "fulfilment", "page", "pageSize"]) delete out[k];
  return out;
};

export const ordersDashboardApi = {
  /** Telecaller Performance (read-only; Admin / Manager). */
  async telecaller(q: import("../types/orders-dashboard.types").TelecallerQuery): Promise<import("../types/orders-dashboard.types").TelecallerPerformanceResult> {
    const params = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== "" && v !== "ALL"));
    return (await apiClient.get<ApiEnvelope<import("../types/orders-dashboard.types").TelecallerPerformanceResult>>("/orders-dashboard/telecaller", { params })).data.data;
  },
  async get(q: OrdersDashboardQuery): Promise<OrdersDashboardResult> {
    return (await apiClient.get<ApiEnvelope<OrdersDashboardResult>>("/orders-dashboard", { params: params(q) })).data.data;
  },
  /** The clicked card's orders for the open tab and date range (all pages) as an .xlsx file. */
  async export(q: OrdersDashboardQuery): Promise<{ blob: Blob; filename: string; truncated: boolean }> {
    const { page: _page, pageSize: _pageSize, ...filters } = q;
    void _page;
    void _pageSize;
    const res = await apiClient.get<Blob>("/orders-dashboard/export", { params: params(filters), responseType: "blob" });
    const disposition = String(res.headers?.["content-disposition"] ?? "");
    const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? "Orders.xlsx";
    return { blob: res.data, filename, truncated: String(res.headers?.["x-export-truncated"]) === "true" };
  },
};

export const abandonedDashboardApi = {
  async get(q: AbandonedQuery): Promise<AbandonedResult> {
    return (await apiClient.get<ApiEnvelope<AbandonedResult>>("/orders-dashboard/abandoned", { params: params(q) })).data.data;
  },
  /** The clicked card's checkouts for the date range (all pages) as an .xlsx file. */
  async export(q: AbandonedQuery): Promise<{ blob: Blob; filename: string; truncated: boolean }> {
    const { page: _page, pageSize: _pageSize, ...filters } = q;
    void _page;
    void _pageSize;
    const res = await apiClient.get<Blob>("/orders-dashboard/abandoned/export", { params: params(filters), responseType: "blob" });
    const disposition = String(res.headers?.["content-disposition"] ?? "");
    const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? "Abandoned_Checkouts.xlsx";
    return { blob: res.data, filename, truncated: String(res.headers?.["x-export-truncated"]) === "true" };
  },
};

type ChartRange = { range: DashboardRangeKind; from?: string; to?: string };
const chartParams = (r: ChartRange, interval: ChartInterval) => ({ ...(r.range === "custom" ? { from: r.from, to: r.to } : {}), range: r.range, interval });

/** Orders & Revenue (Website Orders) and the abandoned-checkouts trend: the SAME date range as the cards above them. */
export const dashboardChartsApi = {
  async orders(r: ChartRange, interval: ChartInterval): Promise<OrdersChartResult> {
    return (await apiClient.get<ApiEnvelope<OrdersChartResult>>("/orders-dashboard/chart", { params: chartParams(r, interval) })).data.data;
  },
  async abandoned(r: ChartRange, interval: ChartInterval): Promise<AbandonedChartResult> {
    return (await apiClient.get<ApiEnvelope<AbandonedChartResult>>("/orders-dashboard/abandoned/chart", { params: chartParams(r, interval) })).data.data;
  },
};
