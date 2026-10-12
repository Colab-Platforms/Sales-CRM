import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  CreateManagerPayload,
  CreateSalespersonPayload,
  ManagerUser,
  ResetPasswordPayload,
  SalespersonUser,
  UpdateManagerPayload,
  UpdateSalespersonPayload,
  HrUser,
  CreateHrPayload,
  Group,
  CreateGroupPayload,
  UpdateGroupPayload,
  AddSalespersonPayload,
  AddExistingMemberPayload,
} from "../types/admin.types";

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

  async resetManagerPassword(id: string, payload: ResetPasswordPayload): Promise<ManagerUser> {
    const res = await apiClient.patch<ApiEnvelope<ManagerUser>>(`/admin/managers/${id}/password`, payload);
    return res.data.data;
  },

  async listSalespersons(): Promise<SalespersonUser[]> {
    const res = await apiClient.get<ApiEnvelope<SalespersonUser[]>>("/admin/salespersons");
    return res.data.data;
  },

  async createSalesperson(payload: CreateSalespersonPayload): Promise<SalespersonUser> {
    const res = await apiClient.post<ApiEnvelope<SalespersonUser>>("/admin/salespersons", payload);
    return res.data.data;
  },

  async updateSalesperson(id: string, payload: UpdateSalespersonPayload): Promise<SalespersonUser> {
    const res = await apiClient.patch<ApiEnvelope<SalespersonUser>>(`/admin/salespersons/${id}`, payload);
    return res.data.data;
  },

  async resetSalespersonPassword(id: string, payload: ResetPasswordPayload): Promise<SalespersonUser> {
    const res = await apiClient.patch<ApiEnvelope<SalespersonUser>>(`/admin/salespersons/${id}/password`, payload);
    return res.data.data;
  },

  async listHr(): Promise<HrUser[]> {
    const res = await apiClient.get<ApiEnvelope<HrUser[]>>("/admin/hr");
    return res.data.data;
  },

  async createHr(payload: CreateHrPayload): Promise<HrUser> {
    const res = await apiClient.post<ApiEnvelope<HrUser>>("/admin/hr", payload);
    return res.data.data;
  },

  async listGroups(): Promise<Group[]> {
    const res = await apiClient.get<ApiEnvelope<Group[]>>("/admin/groups");
    return res.data.data;
  },

  async getGroup(groupId: string): Promise<Group> {
    const res = await apiClient.get<ApiEnvelope<Group>>(`/admin/groups/${groupId}`);
    return res.data.data;
  },

  async createGroup(payload: CreateGroupPayload): Promise<Group> {
    const res = await apiClient.post<ApiEnvelope<Group>>("/admin/groups", payload);
    return res.data.data;
  },

  async updateGroup(groupId: string, payload: UpdateGroupPayload): Promise<Group> {
    const res = await apiClient.patch<ApiEnvelope<Group>>(`/admin/groups/${groupId}`, payload);
    return res.data.data;
  },

  async deleteGroup(groupId: string): Promise<Group> {
    const res = await apiClient.delete<ApiEnvelope<Group>>(`/admin/groups/${groupId}`);
    return res.data.data;
  },

  async addSalespersonToGroup(groupId: string, payload: AddSalespersonPayload): Promise<SalespersonUser> {
    const res = await apiClient.post<ApiEnvelope<SalespersonUser>>(`/admin/groups/${groupId}/members`, payload);
    return res.data.data;
  },

  async addExistingSalespersonToGroup(
    groupId: string,
    payload: AddExistingMemberPayload,
  ): Promise<SalespersonUser> {
    const res = await apiClient.post<ApiEnvelope<SalespersonUser>>(
      `/admin/groups/${groupId}/members/existing`,
      payload,
    );
    return res.data.data;
  },

  async removeSalespersonFromGroup(groupId: string, userId: string): Promise<void> {
    await apiClient.delete(`/admin/groups/${groupId}/members/${userId}`);
  },
};
