import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { CallDetail, CallListParams, CallListResult, CallSummary, CallSummaryParams } from "../types/call-history.types";

/** Thin wrappers over `GET /api/calls`, `GET /api/calls/:id` and `GET /api/calls/summary` — see
 * call-history.types.ts. Also backs the IVR Inbound/Outbound reporting pages (same endpoints,
 * filtered by `direction` - there is no separate IVR API). */
export const callHistoryApi = {
  async list(params: CallListParams): Promise<CallListResult> {
    const res = await apiClient.get<ApiEnvelope<CallListResult>>("/calls", { params });
    return res.data.data;
  },

  async summary(params: CallSummaryParams): Promise<CallSummary> {
    const res = await apiClient.get<ApiEnvelope<CallSummary>>("/calls/summary", { params });
    return res.data.data;
  },

  async get(callId: string): Promise<CallDetail> {
    const res = await apiClient.get<ApiEnvelope<CallDetail>>(`/calls/${callId}`);
    return res.data.data;
  },
};
