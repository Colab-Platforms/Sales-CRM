import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { Group, MySalesperson } from "../types/manager.types";
import type { AnalyticsQuery, ManagerAnalytics, SalespersonAnalytics } from "../types/manager-analytics.types";
import type { SegmentLeadHistory, SegmentReport } from "../types/segment-report.types";

export const managerApi = {
  async listGroups(): Promise<Group[]> {
    const res = await apiClient.get<ApiEnvelope<Group[]>>("/manager/groups");
    return res.data.data;
  },

  async listMySalespersons(): Promise<MySalesperson[]> {
    const res = await apiClient.get<ApiEnvelope<MySalesperson[]>>("/manager/salespersons/mine");
    return res.data.data;
  },
};

export function analyticsParams(q: AnalyticsQuery) {
  return {
    from: q.from,
    to: q.to,
    callStatus: q.callStatus,
    leadStatus: q.leadStatus,
    paymentMode: q.paymentMode,
    orderStatus: q.orderStatus,
    tzOffsetMinutes: q.tzOffsetMinutes,
    ...(q.salespersonId ? { salespersonId: q.salespersonId } : {}),
    ...(q.sourceId ? { sourceId: q.sourceId } : {}),
    ...(q.segmentId ? { segmentId: q.segmentId } : {}),
  };
}

export const managerAnalyticsApi = {
  /** The selected segment's leads and their activity metrics (query.segmentId is required). */
  async segmentReport(q: AnalyticsQuery, page: number, pageSize: number, signal?: AbortSignal): Promise<SegmentReport> {
    const res = await apiClient.get<ApiEnvelope<SegmentReport>>("/manager/analytics/segment", { params: { ...analyticsParams(q), page, pageSize }, signal });
    return res.data.data;
  },

  async segmentLeadHistory(leadId: string, q: AnalyticsQuery, signal?: AbortSignal): Promise<SegmentLeadHistory> {
    const res = await apiClient.get<ApiEnvelope<SegmentLeadHistory>>(`/manager/analytics/segment/leads/${leadId}/history`, { params: analyticsParams(q), signal });
    return res.data.data;
  },

  /** The filtered segment's leads and activity as the server-built Excel file. */
  async segmentXlsx(q: AnalyticsQuery): Promise<Blob> {
    const res = await apiClient.get<Blob>("/manager/analytics/segment/export.xlsx", { params: analyticsParams(q), responseType: "blob" });
    return res.data;
  },

  /** Every order behind the Sales & Revenue figures for these filters, as the server-built CSV file. */
  async salesOrdersCsv(q: AnalyticsQuery): Promise<Blob> {
    const res = await apiClient.get<Blob>("/manager/analytics/orders.csv", { params: analyticsParams(q), responseType: "blob" });
    return res.data;
  },

  async overview(q: AnalyticsQuery, signal?: AbortSignal): Promise<ManagerAnalytics> {
    const res = await apiClient.get<ApiEnvelope<ManagerAnalytics>>("/manager/analytics", { params: analyticsParams(q), signal });
    return res.data.data;
  },

  async salesperson(id: string, q: AnalyticsQuery, signal?: AbortSignal): Promise<SalespersonAnalytics> {
    const res = await apiClient.get<ApiEnvelope<SalespersonAnalytics>>(`/manager/analytics/salespersons/${id}`, {
      params: analyticsParams({ ...q, salespersonId: undefined }),
      signal,
    });
    return res.data.data;
  },
};
