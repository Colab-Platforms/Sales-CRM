"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";
import type { ApiEnvelope } from "@/lib/api-client/types/common.types";
import type { DiscountOptions } from "@/lib/discount";

export type DiscountFlow = "ORDER" | "UPGRADE";

// Until the server answers, the default is the same ₹50 custom discount the server configures; the real value replaces it on load.
const FALLBACK: DiscountOptions = { defaultDiscount: { type: "FIXED", value: "50" }, fastrr: { available: false, coupons: [], reason: null } };

// The default custom discount and the live Fastrr coupons come from GET /discounts/options (nothing is hardcoded in the UI).
export function useDiscountOptions(flow: DiscountFlow, enabled = true) {
  const token = useAuthStore((s) => s.token);
  const q = useQuery({
    queryKey: ["discounts", "options", flow],
    queryFn: async () => (await apiClient.get<ApiEnvelope<DiscountOptions>>("/discounts/options", { params: { flow } })).data.data,
    enabled: Boolean(token) && enabled,
    staleTime: 60_000,
  });
  return { options: q.data ?? FALLBACK, isLoading: q.isPending, loaded: q.isSuccess };
}
