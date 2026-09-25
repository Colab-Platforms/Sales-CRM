import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { InitiateCallResult } from "../types/calls.types";

export const callsApi = {
  /** POST /api/calls — the only telephony call this frontend ever makes; the backend owns provider selection. */
  async initiateCall(leadId: string): Promise<InitiateCallResult> {
    const res = await apiClient.post<ApiEnvelope<InitiateCallResult>>("/calls", { leadId });
    return res.data.data;
  },
};
