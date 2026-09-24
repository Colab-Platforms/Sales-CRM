import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { ListShipmentsParams, ListShipmentsResult, ShipmentDetailResult, ShipmentFilterOptions } from "../types/shiprocket.types";

// The centralized Shiprocket listing/tracking page. Shipment actions themselves (assign AWB, pickup, label, refresh
// tracking) stay in integrations.api.ts, which this page's detail view calls directly - no second implementation.
export const shiprocketApi = {
  async list(params: ListShipmentsParams): Promise<ListShipmentsResult> {
    // axios drops undefined params, so unset filters never reach the URL.
    const res = await apiClient.get<ApiEnvelope<ListShipmentsResult>>("/shipments", { params });
    return res.data.data;
  },

  async get(shipmentId: string): Promise<ShipmentDetailResult> {
    const res = await apiClient.get<ApiEnvelope<ShipmentDetailResult>>(`/shipments/${shipmentId}`);
    return res.data.data;
  },

  async getFilterOptions(): Promise<ShipmentFilterOptions> {
    const res = await apiClient.get<ApiEnvelope<ShipmentFilterOptions>>("/shipments/filter-options");
    return res.data.data;
  },
};
