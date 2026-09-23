import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { CallDetail, CallListParams, CallListResult } from "../types/call-history.types";

/** Thin wrappers over `GET /api/calls` and `GET /api/calls/:id` — see call-history.types.ts. */
export const callHistoryApi = {
  async list(params: CallListParams): Promise<CallListResult> {
    const res = await apiClient.get<ApiEnvelope<CallListResult>>("/calls", { params });
    return res.data.data;
  },

  async get(callId: string): Promise<CallDetail> {
    const res = await apiClient.get<ApiEnvelope<CallDetail>>(`/calls/${callId}`);
    return res.data.data;
  },
};
