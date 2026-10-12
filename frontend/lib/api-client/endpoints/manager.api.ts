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
    tzOffsetMinutes: q.tzOffsetMinutes,
    ...(q.salespersonId ? { salespersonId: q.salespersonId } : {}),
  };
}

export const managerAnalyticsApi = {
  async overview(q: AnalyticsQuery): Promise<ManagerAnalytics> {
    const res = await apiClient.get<ApiEnvelope<ManagerAnalytics>>("/manager/analytics", { params: analyticsParams(q) });
    return res.data.data;
  },

  async salesperson(id: string, q: AnalyticsQuery): Promise<SalespersonAnalytics> {
    const res = await apiClient.get<ApiEnvelope<SalespersonAnalytics>>(`/manager/analytics/salespersons/${id}`, {
      params: analyticsParams({ ...q, salespersonId: undefined }),
    });
    return res.data.data;
  },
};
