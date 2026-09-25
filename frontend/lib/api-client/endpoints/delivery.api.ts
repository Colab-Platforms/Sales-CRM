import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { LastShippingAddress, PincodeLookup, ServiceabilityResult } from "../types/delivery.types";

export const deliveryApi = {
  async pincode(pincode: string): Promise<PincodeLookup> {
    const res = await apiClient.get<ApiEnvelope<PincodeLookup>>(`/delivery/pincode/${encodeURIComponent(pincode)}`);
    return res.data.data;
  },
  async serviceability(params: { pincode: string; cod: boolean; weight: number }): Promise<ServiceabilityResult> {
    const res = await apiClient.get<ApiEnvelope<ServiceabilityResult>>("/delivery/serviceability", { params: { pincode: params.pincode, cod: params.cod ? "1" : "0", weight: params.weight } });
    return res.data.data;
  },
  async lastAddress(leadId: string): Promise<LastShippingAddress | null> {
    const res = await apiClient.get<ApiEnvelope<{ address: LastShippingAddress | null }>>("/orders/last-address", { params: { leadId } });
    return res.data.data.address;
  },
};
