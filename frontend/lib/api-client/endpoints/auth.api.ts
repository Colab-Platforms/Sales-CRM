import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { CurrentUser, LoginPayload, LoginResult } from "../types/auth.types";

export const authApi = {
  async login(payload: LoginPayload): Promise<LoginResult> {
    const res = await apiClient.post<ApiEnvelope<LoginResult>>("/auth/login", payload);
    return res.data.data;
  },

  async me(): Promise<CurrentUser> {
    const res = await apiClient.get<ApiEnvelope<CurrentUser>>("/auth/me");
    return res.data.data;
  },
};
