import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { LastShippingAddressResult, PincodeLookup, ServiceabilityResult } from "../types/delivery.types";

export const deliveryApi = {
  async pincode(pincode: string): Promise<PincodeLookup> {
    const res = await apiClient.get<ApiEnvelope<PincodeLookup>>(`/delivery/pincode/${encodeURIComponent(pincode)}`);
    return res.data.data;
  },
  async serviceability(params: { pincode: string; cod: boolean; weight: number; dims?: { length: number; breadth: number; height: number }; value?: number }): Promise<ServiceabilityResult> {
    const res = await apiClient.get<ApiEnvelope<ServiceabilityResult>>("/delivery/serviceability", {
      params: { pincode: params.pincode, cod: params.cod ? "1" : "0", weight: params.weight, ...(params.dims ?? {}), ...(params.value !== undefined ? { value: params.value } : {}) },
    });
    return res.data.data;
  },
  async lastAddress(leadId: string): Promise<LastShippingAddressResult> {
    const res = await apiClient.get<ApiEnvelope<LastShippingAddressResult>>("/orders/last-address", { params: { leadId } });
    return res.data.data;
  },
};
