import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { Group, MySalesperson } from "../types/manager.types";
import type { AnalyticsQuery, ManagerAnalytics, SalespersonAnalytics } from "../types/manager-analytics.types";

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

function analyticsParams(q: AnalyticsQuery) {
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
  };
}

export const managerAnalyticsApi = {
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
