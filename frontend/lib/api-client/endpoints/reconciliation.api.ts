import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { ReconciliationListParams, ReconciliationResult } from "../types/reconciliation.types";

export const reconciliationApi = {
  async list(params: ReconciliationListParams): Promise<ReconciliationResult> {
    // axios drops undefined params, so unset filters never reach the URL.
    const res = await apiClient.get<ApiEnvelope<ReconciliationResult>>("/orders/reconciliation", { params });
    return res.data.data;
  },
};
