import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { ActiveOffersResult } from "../types/offers.types";

export const offersApi = {
  /** Read-only. The backend talks to Fastrr (credentials never reach the browser) and caches briefly. */
  async active(): Promise<ActiveOffersResult> {
    const res = await apiClient.get<ApiEnvelope<ActiveOffersResult>>("/offers/active");
    return res.data.data;
  },
};
