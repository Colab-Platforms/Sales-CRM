import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  OrderDetail,
  OrderFilterOptions,
  OrderListResult,
  OrderStatusHistory,
  OrdersListParams,
} from "../types/orders.types";

export const ordersApi = {
  async list(params: OrdersListParams): Promise<OrderListResult> {
    // axios drops undefined params, so unset filters never reach the URL.
    const res = await apiClient.get<ApiEnvelope<OrderListResult>>("/orders", { params });
    return res.data.data;
  },

  async get(id: string): Promise<OrderDetail> {
    const res = await apiClient.get<ApiEnvelope<OrderDetail>>(`/orders/${id}`);
    return res.data.data;
  },

  async getStatusHistory(id: string): Promise<OrderStatusHistory> {
    const res = await apiClient.get<ApiEnvelope<OrderStatusHistory>>(`/orders/${id}/status-history`);
    return res.data.data;
  },

  async getFilterOptions(): Promise<OrderFilterOptions> {
    const res = await apiClient.get<ApiEnvelope<OrderFilterOptions>>("/orders/filter-options");
    return res.data.data;
  },
};
