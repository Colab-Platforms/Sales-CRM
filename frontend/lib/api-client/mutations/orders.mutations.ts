import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ordersApi } from "../endpoints/orders.api";
import { ordersKeys } from "../queries/orders.queries";
import { customersKeys } from "../queries/customers.queries";
import { whatsappHistoryKeys } from "../queries/whatsapp-history.queries";
import type { CancelOrderInput, CancelOrderResult, CreateManualOrderInput, CreateManualOrderResult, ShopifyPushResult } from "../types/orders.types";

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
      queryClient.invalidateQueries({ queryKey: customersKeys.detail(result.order.customer.leadId) });
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
