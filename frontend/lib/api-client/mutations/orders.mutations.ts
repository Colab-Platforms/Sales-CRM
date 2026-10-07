import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ordersApi } from "../endpoints/orders.api";
import { ordersKeys } from "../queries/orders.queries";
import { customersKeys } from "../queries/customers.queries";
import { auditKeys } from "../queries/audit.queries";
import { whatsappHistoryKeys } from "../queries/whatsapp-history.queries";
import type { CancelOrderInput, CancelOrderResult, RevertCancellationResult, CreateManualOrderInput, CreateManualOrderResult, LiveOrderCancelResult, LiveOrderSyncResult, ShopifyPushResult } from "../types/orders.types";

export function useCreateOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation<CreateManualOrderResult, unknown, CreateManualOrderInput>({
    mutationFn: (input) => ordersApi.create(input),
    onSuccess: (_, variables) => {
      // The new order must show up everywhere an order already does: the Orders list, Customer 360
      // (profile + orders list + timeline), and the WhatsApp Inbox's own conversation list (its
      // "latest message" ordering is unaffected, but the underlying lead's data just changed).
      queryClient.invalidateQueries({ queryKey: ordersKeys.all });
      queryClient.invalidateQueries({ queryKey: customersKeys.detail(variables.leadId) });
      queryClient.invalidateQueries({ queryKey: [...customersKeys.all, "timeline", variables.leadId] });
      queryClient.invalidateQueries({ queryKey: whatsappHistoryKeys.all });
    },
  });
}

export function useCancelOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation<CancelOrderResult, unknown, { orderId: string } & CancelOrderInput>({
    mutationFn: ({ orderId, ...input }) => ordersApi.cancel(orderId, input),
    onSuccess: (result, { orderId }) => {
      queryClient.invalidateQueries({ queryKey: ordersKeys.detail(orderId) });
      queryClient.invalidateQueries({ queryKey: ordersKeys.lists() });
      // The Orders page reads the live list, which embeds the CRM status - refresh it so the row updates.
      queryClient.invalidateQueries({ queryKey: ordersKeys.liveLists() });
      queryClient.invalidateQueries({ queryKey: ordersKeys.statusHistory(orderId) });
      queryClient.invalidateQueries({ queryKey: auditKeys.all });
      queryClient.invalidateQueries({ queryKey: customersKeys.detail(result.order.customer.leadId) });
    },
  });
}

export function useRevertCancellationMutation() {
  const queryClient = useQueryClient();
  return useMutation<RevertCancellationResult, unknown, { orderId: string }>({
    mutationFn: ({ orderId }) => ordersApi.revertCancellation(orderId),
    onSuccess: (result, { orderId }) => {
      queryClient.invalidateQueries({ queryKey: ordersKeys.detail(orderId) });
      queryClient.invalidateQueries({ queryKey: ordersKeys.lists() });
      // The Orders page reads the live list, which embeds the CRM status - refresh it so the row updates.
      queryClient.invalidateQueries({ queryKey: ordersKeys.liveLists() });
      queryClient.invalidateQueries({ queryKey: ordersKeys.statusHistory(orderId) });
      queryClient.invalidateQueries({ queryKey: auditKeys.all });
      queryClient.invalidateQueries({ queryKey: customersKeys.detail(result.order.customer.leadId) });
    },
  });
}

/** Brings a live-only Shopify order into the CRM; afterwards the CRM order page replaces the live page. */
export function useSyncLiveOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation<LiveOrderSyncResult, unknown, string>({
    mutationFn: (externalId) => ordersApi.syncLive(externalId),
    onSuccess: (_, externalId) => {
      queryClient.invalidateQueries({ queryKey: ordersKeys.liveDetail(externalId) });
      queryClient.invalidateQueries({ queryKey: ordersKeys.liveLists() });
      queryClient.invalidateQueries({ queryKey: ordersKeys.lists() });
    },
  });
}

/** Cancels a Shopify order not yet synced into the CRM - the only destructive action Shopify supports. */
export function useCancelLiveOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation<LiveOrderCancelResult, unknown, string>({
    mutationFn: (externalId) => ordersApi.cancelLive(externalId),
    onSuccess: (_, externalId) => {
      queryClient.invalidateQueries({ queryKey: ordersKeys.liveDetail(externalId) });
      queryClient.invalidateQueries({ queryKey: ordersKeys.liveLists() });
    },
  });
}

export function usePushOrderToShopifyMutation() {
  const queryClient = useQueryClient();
  return useMutation<ShopifyPushResult, unknown, string>({
    mutationFn: (orderId) => ordersApi.pushToShopify(orderId),
    onSuccess: (_, orderId) => {
      queryClient.invalidateQueries({ queryKey: ordersKeys.detail(orderId) });
      queryClient.invalidateQueries({ queryKey: ordersKeys.lists() });
    },
  });
}

export function useRetryConfirmationTagSyncMutation() {
  const queryClient = useQueryClient();
  return useMutation<{ status: "synced" | "unchanged" | "not_linked" | "not_confirmed" | "failed"; tag?: string; reason?: string }, unknown, string>({
    mutationFn: (orderId) => ordersApi.retryConfirmationTagSync(orderId),
    onSuccess: (_, orderId) => {
      queryClient.invalidateQueries({ queryKey: ordersKeys.detail(orderId) });
    },
  });
}

export function useRetryShopifyPaymentSyncMutation() {
  const queryClient = useQueryClient();
  return useMutation<{ status: "synced" | "not_linked" | "failed"; reason?: string }, unknown, string>({
    mutationFn: (orderId) => ordersApi.retryShopifyPaymentSync(orderId),
    onSuccess: (_, orderId) => {
      queryClient.invalidateQueries({ queryKey: ordersKeys.detail(orderId) });
    },
  });
}
