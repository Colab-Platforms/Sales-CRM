import { useMutation, useQueryClient } from "@tanstack/react-query";
import { integrationsApi } from "../endpoints/integrations.api";
import { auditKeys } from "../queries/audit.queries";
import { customersKeys } from "../queries/customers.queries";
import { ordersKeys } from "../queries/orders.queries";
import { reconciliationKeys } from "../queries/reconciliation.queries";
import { whatsappHistoryKeys } from "../queries/whatsapp-history.queries";
import { whatsappKeys } from "../queries/whatsapp.queries";
import type { CreateShipmentInput, PaymentLinkResult, ShipmentActionResult } from "../types/integrations.types";
import type { WhatsAppMessageResult } from "../types/whatsapp-messaging.types";

// A payment or shipment change shows up in the order itself, its list and status, the reconciliation totals and the audit
// trail - so all of those are refreshed together.
function useRefreshOrderData() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ordersKeys.all });
    queryClient.invalidateQueries({ queryKey: reconciliationKeys.all });
    queryClient.invalidateQueries({ queryKey: auditKeys.all });
    queryClient.invalidateQueries({ queryKey: customersKeys.all });
  };
}

export function useCreatePaymentLinkMutation() {
  const refresh = useRefreshOrderData();
  return useMutation<PaymentLinkResult, unknown, string>({ mutationFn: (orderId) => integrationsApi.createPaymentLink(orderId), onSuccess: refresh });
}

export function useRefreshPaymentMutation() {
  const refresh = useRefreshOrderData();
  return useMutation<PaymentLinkResult, unknown, string>({ mutationFn: (paymentId) => integrationsApi.refreshPayment(paymentId), onSuccess: refresh });
}

export function useCancelPaymentLinkMutation() {
  const refresh = useRefreshOrderData();
  return useMutation<PaymentLinkResult, unknown, string>({ mutationFn: (paymentId) => integrationsApi.cancelPaymentLink(paymentId), onSuccess: refresh });
}

export function useSendPaymentLinkMutation() {
  const queryClient = useQueryClient();
  const refresh = useRefreshOrderData();
  return useMutation<WhatsAppMessageResult, unknown, { paymentId: string; templateId: string }>({
    mutationFn: ({ paymentId, templateId }) => integrationsApi.sendPaymentLinkWhatsApp(paymentId, templateId),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: whatsappKeys.all });
      queryClient.invalidateQueries({ queryKey: whatsappHistoryKeys.all });
    },
  });
}

export function useCreateShipmentMutation() {
  const refresh = useRefreshOrderData();
  return useMutation<ShipmentActionResult, unknown, { orderId: string; input: CreateShipmentInput }>({
    mutationFn: ({ orderId, input }) => integrationsApi.createShipment(orderId, input),
    onSuccess: refresh,
  });
}

export function useAssignAwbMutation() {
  const refresh = useRefreshOrderData();
  return useMutation<ShipmentActionResult, unknown, { shipmentId: string; courierId: number }>({
    mutationFn: ({ shipmentId, courierId }) => integrationsApi.assignAwb(shipmentId, courierId),
    onSuccess: refresh,
  });
}

export function useSchedulePickupMutation() {
  const refresh = useRefreshOrderData();
  return useMutation<ShipmentActionResult, unknown, string>({ mutationFn: (shipmentId) => integrationsApi.schedulePickup(shipmentId), onSuccess: refresh });
}

export function useGenerateLabelMutation() {
  const refresh = useRefreshOrderData();
  return useMutation<ShipmentActionResult, unknown, string>({ mutationFn: (shipmentId) => integrationsApi.generateLabel(shipmentId), onSuccess: refresh });
}

export function useRefreshTrackingMutation() {
  const refresh = useRefreshOrderData();
  return useMutation<ShipmentActionResult, unknown, string>({ mutationFn: (shipmentId) => integrationsApi.refreshTracking(shipmentId), onSuccess: refresh });
}
