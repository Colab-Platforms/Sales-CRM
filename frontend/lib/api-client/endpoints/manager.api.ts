import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  CreateGroupPayload,
  AddSalespersonPayload,
  AddExistingMemberPayload,
  Group,
  MySalesperson,
  SalespersonUser,
  SalespersonWithGroup,
  UpdateGroupPayload,
  UpdateSalespersonPayload,
} from "../types/manager.types";

export const managerApi = {
  async listGroups(): Promise<Group[]> {
    const res = await apiClient.get<ApiEnvelope<Group[]>>("/manager/groups");
    return res.data.data;
  },

  async listSalespersons(): Promise<SalespersonWithGroup[]> {
    const res = await apiClient.get<ApiEnvelope<SalespersonWithGroup[]>>("/manager/salespersons");
    return res.data.data;
  },

  async listMySalespersons(): Promise<MySalesperson[]> {
    const res = await apiClient.get<ApiEnvelope<MySalesperson[]>>("/manager/salespersons/mine");
    return res.data.data;
  },

  async createGroup(payload: CreateGroupPayload): Promise<Group> {
    const res = await apiClient.post<ApiEnvelope<Group>>("/manager/groups", payload);
    return res.data.data;
  },

  async updateGroup(groupId: string, payload: UpdateGroupPayload): Promise<Group> {
    const res = await apiClient.patch<ApiEnvelope<Group>>(`/manager/groups/${groupId}`, payload);
    return res.data.data;
  },

  async deleteGroup(groupId: string): Promise<Group> {
    const res = await apiClient.delete<ApiEnvelope<Group>>(`/manager/groups/${groupId}`);
    return res.data.data;
  },

  async addSalesperson(groupId: string, payload: AddSalespersonPayload): Promise<SalespersonUser> {
    const res = await apiClient.post<ApiEnvelope<SalespersonUser>>(`/manager/groups/${groupId}/members`, payload);
    return res.data.data;
  },

  async addExistingSalesperson(groupId: string, payload: AddExistingMemberPayload): Promise<SalespersonUser> {
    const res = await apiClient.post<ApiEnvelope<SalespersonUser>>(
      `/manager/groups/${groupId}/members/existing`,
      payload,
    );
    return res.data.data;
  },

  async updateSalesperson(groupId: string, userId: string, payload: UpdateSalespersonPayload): Promise<SalespersonUser> {
    const res = await apiClient.patch<ApiEnvelope<SalespersonUser>>(
      `/manager/groups/${groupId}/members/${userId}`,
      payload,
    );
    return res.data.data;
  },

  async removeSalesperson(groupId: string, userId: string): Promise<void> {
    await apiClient.delete(`/manager/groups/${groupId}/members/${userId}`);
  },
};
