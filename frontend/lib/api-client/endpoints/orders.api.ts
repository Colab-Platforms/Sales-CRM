import { apiClient } from "../client";
import type { WhatsAppPaymentOptions } from "../../whatsapp-payment";
import type { ApiEnvelope } from "../types/common.types";
import type {
  CancelOrderInput,
  CancelOrderResult,
  RevertCancellationResult,
  CreateManualOrderInput,
  CreateManualOrderResult,
  LiveOrderCancelResult,
  LiveOrderDetailResult,
  LiveOrderHistoryParams,
  LiveOrderHistoryResult,
  LiveOrderListResult,
  LiveOrdersListParams,
  OrderDetail,
  LiveOrderTagOptions,
  OrderFilterOptions,
  OrderListResult,
  OrderStatusHistory,
  OrdersListParams,
  ShopifyPushResult,
} from "../types/orders.types";

export const ordersApi = {
  async list(params: OrdersListParams): Promise<OrderListResult> {
    // axios drops undefined params, so unset filters never reach the URL.
    const res = await apiClient.get<ApiEnvelope<OrderListResult>>("/orders", { params });
    return res.data.data;
  },

  /** The Orders list page's real data source: live from Shopify, cursor-paginated. See GET /orders
   *  above (kept, unchanged) for the original CRM-DB-backed list still used elsewhere. */
  async listLive(params: LiveOrdersListParams): Promise<LiveOrderListResult> {
    // List filters travel as one comma-separated value each ("COD,PREPAID"), which is what the API validates.
    const query = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? (v.length ? v.join(",") : undefined) : v]));
    const res = await apiClient.get<ApiEnvelope<LiveOrderListResult>>("/orders/live", { params: query });
    return res.data.data;
  },

  async get(id: string): Promise<OrderDetail> {
    const res = await apiClient.get<ApiEnvelope<OrderDetail>>(`/orders/${id}`);
    return res.data.data;
  },

  /** Order Detail for a Shopify order not yet synced into the CRM - see parseLiveOrderId(). */
  async getLiveDetail(externalId: string): Promise<LiveOrderDetailResult> {
    const res = await apiClient.get<ApiEnvelope<LiveOrderDetailResult>>(`/orders/live/${externalId}`);
    return res.data.data;
  },

  /** "Previous Orders" on the live Order Detail page - the Shopify customer's other orders, cursor-paginated. */
  async getLiveHistory(shopifyCustomerId: string, params: LiveOrderHistoryParams): Promise<LiveOrderHistoryResult> {
    const res = await apiClient.get<ApiEnvelope<LiveOrderHistoryResult>>(`/orders/live/customer/${shopifyCustomerId}/history`, { params });
    return res.data.data;
  },

  async create(input: CreateManualOrderInput): Promise<CreateManualOrderResult> {
    const res = await apiClient.post<ApiEnvelope<CreateManualOrderResult>>("/orders", input);
    return res.data.data;
  },

  async cancel(orderId: string, input: CancelOrderInput): Promise<CancelOrderResult> {
    const res = await apiClient.post<ApiEnvelope<CancelOrderResult>>(`/orders/${orderId}/cancel`, input);
    return res.data.data;
  },

  async revertCancellation(orderId: string): Promise<RevertCancellationResult> {
    const res = await apiClient.post<ApiEnvelope<RevertCancellationResult>>(`/orders/${orderId}/revert-cancel`);
    return res.data.data;
  },

  /** Cancels a Shopify order not yet synced into the CRM - the only destructive action Shopify supports. */
  async cancelLive(externalId: string): Promise<LiveOrderCancelResult> {
    const res = await apiClient.post<ApiEnvelope<LiveOrderCancelResult>>(`/orders/live/${externalId}/cancel`);
    return res.data.data;
  },

  async pushToShopify(orderId: string): Promise<ShopifyPushResult> {
    const res = await apiClient.post<ApiEnvelope<ShopifyPushResult>>(`/orders/${orderId}/shopify-order`);
    return res.data.data;
  },

  async retryShopifyPaymentSync(orderId: string): Promise<{ status: "synced" | "not_linked" | "failed"; reason?: string }> {
    const res = await apiClient.post<ApiEnvelope<{ status: "synced" | "not_linked" | "failed"; reason?: string }>>(`/orders/${orderId}/shopify-payment-sync/retry`);
    return res.data.data;
  },

  async retryConfirmationTagSync(orderId: string): Promise<{ status: "synced" | "unchanged" | "not_linked" | "not_confirmed" | "failed"; tag?: string; reason?: string }> {
    const res = await apiClient.post<ApiEnvelope<{ status: "synced" | "unchanged" | "not_linked" | "not_confirmed" | "failed"; tag?: string; reason?: string }>>(`/orders/${orderId}/shopify-confirmation-tag/retry`);
    return res.data.data;
  },

  async getStatusHistory(id: string): Promise<OrderStatusHistory> {
    const res = await apiClient.get<ApiEnvelope<OrderStatusHistory>>(`/orders/${id}/status-history`);
    return res.data.data;
  },

  async getWhatsAppPaymentOptions(leadId: string): Promise<WhatsAppPaymentOptions> {
    const res = await apiClient.get<ApiEnvelope<WhatsAppPaymentOptions>>("/orders/whatsapp-payment-options", { params: { leadId } });
    return res.data.data;
  },

  async getLiveTagOptions(): Promise<LiveOrderTagOptions> {
    const res = await apiClient.get<ApiEnvelope<LiveOrderTagOptions>>("/orders/live/tag-options");
    return res.data.data;
  },

  async getFilterOptions(): Promise<OrderFilterOptions> {
    const res = await apiClient.get<ApiEnvelope<OrderFilterOptions>>("/orders/filter-options");
    return res.data.data;
  },
};
