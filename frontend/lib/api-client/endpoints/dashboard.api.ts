import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { DashboardData } from "../types/dashboard.types";

export const dashboardApi = {
  async get(): Promise<DashboardData> {
    const res = await apiClient.get<ApiEnvelope<DashboardData>>("/dashboard");
    return res.data.data;
  },
};
