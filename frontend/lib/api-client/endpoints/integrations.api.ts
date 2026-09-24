import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { CourierOption, CreateShipmentInput, IntegrationStatus, PaymentLinkResult, ShipmentActionResult } from "../types/integrations.types";
import type { WhatsAppMessageResult } from "../types/whatsapp-messaging.types";

export const integrationsApi = {
  async getStatus(): Promise<IntegrationStatus> {
    const res = await apiClient.get<ApiEnvelope<IntegrationStatus>>("/integrations/status");
    return res.data.data;
  },

  // ---- Cashfree payment links
  async createPaymentLink(orderId: string): Promise<PaymentLinkResult> {
    const res = await apiClient.post<ApiEnvelope<PaymentLinkResult>>(`/orders/${orderId}/payment-links`);
    return res.data.data;
  },

  async refreshPayment(paymentId: string): Promise<PaymentLinkResult> {
    const res = await apiClient.post<ApiEnvelope<PaymentLinkResult>>(`/payments/${paymentId}/refresh`);
    return res.data.data;
  },

  async cancelPaymentLink(paymentId: string): Promise<PaymentLinkResult> {
    const res = await apiClient.post<ApiEnvelope<PaymentLinkResult>>(`/payments/${paymentId}/cancel-link`);
    return res.data.data;
  },

  // Goes through the existing WhatsApp template messaging on the backend; the template must contain {{payment_link}}.
  async sendPaymentLinkWhatsApp(paymentId: string, templateId: string): Promise<WhatsAppMessageResult> {
    const res = await apiClient.post<ApiEnvelope<WhatsAppMessageResult>>(`/payments/${paymentId}/send-whatsapp`, { templateId });
    return res.data.data;
  },

  // ---- Shiprocket shipments
  async createShipment(orderId: string, input: CreateShipmentInput): Promise<ShipmentActionResult> {
    const res = await apiClient.post<ApiEnvelope<ShipmentActionResult>>(`/orders/${orderId}/shipments`, input);
    return res.data.data;
  },

  async listCouriers(shipmentId: string): Promise<CourierOption[]> {
    const res = await apiClient.get<ApiEnvelope<CourierOption[]>>(`/shipments/${shipmentId}/couriers`);
    return res.data.data;
  },

  async assignAwb(shipmentId: string, courierId: number): Promise<ShipmentActionResult> {
    const res = await apiClient.post<ApiEnvelope<ShipmentActionResult>>(`/shipments/${shipmentId}/assign-awb`, { courierId });
    return res.data.data;
  },

  async schedulePickup(shipmentId: string): Promise<ShipmentActionResult> {
    const res = await apiClient.post<ApiEnvelope<ShipmentActionResult>>(`/shipments/${shipmentId}/pickup`);
    return res.data.data;
  },

  async generateLabel(shipmentId: string): Promise<ShipmentActionResult> {
    const res = await apiClient.post<ApiEnvelope<ShipmentActionResult>>(`/shipments/${shipmentId}/label`);
    return res.data.data;
  },

  async refreshTracking(shipmentId: string): Promise<ShipmentActionResult> {
    const res = await apiClient.post<ApiEnvelope<ShipmentActionResult>>(`/shipments/${shipmentId}/refresh-tracking`);
    return res.data.data;
  },
};
