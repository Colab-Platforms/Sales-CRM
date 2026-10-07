"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient, getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";
import type { ApiEnvelope } from "@/lib/api-client/types/common.types";
import type { CreatePrepaidUpgradeInput, PrepaidUpgradeActionResult, PrepaidUpgradeView } from "@/lib/api-client/types/prepaid-upgrade.types";

// Prepaid Upgrade is a property of the ORDER, so it is addressed either by the CRM order id, or - on the Shopify order page -
// by the Shopify order id (which works whether or not the CRM has synced that order; the backend resolves it).
export type UpgradeTarget = { kind: "crm"; orderId: string } | { kind: "live"; externalId: string };

const path = (t: UpgradeTarget) => (t.kind === "crm" ? `/orders/${t.orderId}/prepaid-upgrade` : `/orders/live/${t.externalId}/prepaid-upgrade`);
const keyOf = (t: UpgradeTarget) => ["orders", "prepaid-upgrade", t.kind, t.kind === "crm" ? t.orderId : t.externalId] as const;
const unwrap = async <T,>(p: Promise<{ data: ApiEnvelope<T> }>) => (await p).data.data;

export function usePrepaidUpgrade(target: UpgradeTarget) {
  const token = useAuthStore((s) => s.token);
  const query = useQuery({ queryKey: keyOf(target), queryFn: () => unwrap(apiClient.get<ApiEnvelope<PrepaidUpgradeView>>(path(target))), enabled: Boolean(token), staleTime: 15_000, retry: 1 });
  return { data: query.data ?? null, isLoading: query.isPending, error: query.error ? getErrorMessage(query.error, "Could not load the prepaid upgrade.") : null };
}

// Every action refreshes everything order-related (detail pages, lists, live lists, offers): they all read the same order.
function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["orders"] });
}

export function useCreatePrepaidOffer(target: UpgradeTarget) {
  const refresh = useRefresh();
  return useMutation<PrepaidUpgradeActionResult, unknown, CreatePrepaidUpgradeInput>({ mutationFn: (input) => unwrap(apiClient.post<ApiEnvelope<PrepaidUpgradeActionResult>>(path(target), input)), onSuccess: refresh });
}

// Link generation and decline always act on the CRM order the offer lives on (a Shopify order has one after its first offer).
export function useGeneratePrepaidLink() {
  const refresh = useRefresh();
  return useMutation<PrepaidUpgradeActionResult, unknown, { orderId: string; upgradeId: string }>({ mutationFn: ({ orderId, upgradeId }) => unwrap(apiClient.post<ApiEnvelope<PrepaidUpgradeActionResult>>(`/orders/${orderId}/prepaid-upgrade/${upgradeId}/payment-link`)), onSuccess: refresh });
}

export function useDeclinePrepaidOffer() {
  const refresh = useRefresh();
  return useMutation<PrepaidUpgradeActionResult, unknown, { orderId: string; upgradeId: string }>({ mutationFn: ({ orderId, upgradeId }) => unwrap(apiClient.post<ApiEnvelope<PrepaidUpgradeActionResult>>(`/orders/${orderId}/prepaid-upgrade/${upgradeId}/decline`)), onSuccess: refresh });
}
