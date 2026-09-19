import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { CreateManagerPayload, ManagerUser, UpdateManagerPayload } from "../types/admin.types";

export const adminApi = {
  async listManagers(): Promise<ManagerUser[]> {
    const res = await apiClient.get<ApiEnvelope<ManagerUser[]>>("/admin/managers");
    return res.data.data;
  },

  async createManager(payload: CreateManagerPayload): Promise<ManagerUser> {
    const res = await apiClient.post<ApiEnvelope<ManagerUser>>("/admin/managers", payload);
    return res.data.data;
  },

  async updateManager(id: string, payload: UpdateManagerPayload): Promise<ManagerUser> {
    const res = await apiClient.patch<ApiEnvelope<ManagerUser>>(`/admin/managers/${id}`, payload);
    return res.data.data;
  },

  async deactivateManager(id: string): Promise<ManagerUser> {
    const res = await apiClient.delete<ApiEnvelope<ManagerUser>>(`/admin/managers/${id}`);
    return res.data.data;
  },
};
