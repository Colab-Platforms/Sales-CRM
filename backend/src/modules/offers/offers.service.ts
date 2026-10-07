import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ProviderHttpError, requestJson } from "../integrations/integrations.common.js";
import { FastrrConfigError, loadFastrrConfig, type FastrrConfig } from "./fastrr.config.js";
import { extractRules, toActiveOffers } from "./offers.mapper.js";
import type { ActiveOffersResult } from "./offers.types.js";

// Read-only. The only Fastrr call is GET /fastrr/promotion/discounts - this module never creates, edits, deletes or
// toggles a discount. Reusable: other modules (order flow, WhatsApp...) can call getActiveOffers() later.
export const DISCOUNTS_PATH = "/fastrr/promotion/discounts";
export const CACHE_TTL_MS = 2 * 60 * 1000;

interface Deps {
  config?: () => FastrrConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

class OffersService {
  // Raw list cached (not the active filter) so "active" is always judged on the server clock at read time.
  private cache: { rules: unknown[]; fetchedAt: Date; expiresAt: number } | null = null;
  private inFlight: Promise<{ rules: unknown[]; fetchedAt: Date }> | null = null;

  constructor(private readonly deps: Deps = {}) {}

  private now = () => (this.deps.now ?? (() => new Date()))();

  private async fetchRules(): Promise<{ rules: unknown[]; fetchedAt: Date }> {
    let config: FastrrConfig;
    try {
      config = (this.deps.config ?? loadFastrrConfig)();
    } catch (error) {
      if (error instanceof FastrrConfigError) throw new ApiError(error.message, STATUS_CODES.SERVICE_UNAVAILABLE);
      throw error;
    }
    try {
      // Authorization is built here and never logged or returned.
      const { json } = await requestJson({ provider: "SHIPROCKET", fetchImpl: this.deps.fetchImpl ?? fetch, url: `${config.baseUrl}${DISCOUNTS_PATH}`, method: "GET", headers: { Authorization: `Bearer ${config.token}` } });
      return { rules: extractRules(json), fetchedAt: this.now() };
    } catch (error) {
      if (error instanceof ProviderHttpError) throw new ApiError("Unable to load active offers from Fastrr.", 502);
      throw new ApiError("Unable to load active offers from Fastrr.", 502);
    }
  }

  async getActiveOffers(): Promise<ActiveOffersResult> {
    const nowMs = this.now().getTime();
    if (!this.cache || this.cache.expiresAt <= nowMs) {
      // Concurrent page loads share one Fastrr request. Failures are never cached, so Retry hits Fastrr again.
      this.inFlight ??= this.fetchRules().finally(() => {
        this.inFlight = null;
      });
      const fresh = await this.inFlight;
      this.cache = { ...fresh, expiresAt: this.now().getTime() + CACHE_TTL_MS };
    }
    return { offers: toActiveOffers({ data: this.cache.rules }, this.now()), fetchedAt: this.cache.fetchedAt.toISOString() };
  }
}

export default OffersService;
