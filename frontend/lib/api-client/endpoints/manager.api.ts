import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { Group, MySalesperson } from "../types/manager.types";

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
