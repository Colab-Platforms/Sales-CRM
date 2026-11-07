"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { couponsApi, type CouponInput, type CustomerType } from "@/lib/api-client/endpoints/coupons.api";

const KEY = ["coupons"] as const;

export function useCouponsQuery(enabled = true) {
  return useQuery({ queryKey: KEY, queryFn: couponsApi.list, enabled });
}

/** Every change refreshes the coupon list AND what the order screen offers. */
function useRefreshing<TVars, TData>(fn: (v: TVars) => Promise<TData>) {
  const qc = useQueryClient();
  return useMutation<TData, unknown, TVars>({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["discounts", "options"] });
    },
  });
}

export const useCreateCouponMutation = () => useRefreshing((input: CouponInput) => couponsApi.create(input));
export const useUpdateCouponMutation = () => useRefreshing((v: { id: string; input: CouponInput }) => couponsApi.update(v.id, v.input));
export const useSetCouponActiveMutation = () => useRefreshing((v: { id: string; isActive: boolean }) => couponsApi.setActive(v.id, v.isActive));
export const useDeleteCouponMutation = () => useRefreshing((id: string) => couponsApi.remove(id));
export const useSetCustomerTypeMutation = () => useRefreshing((v: { leadId: string; customerType: CustomerType }) => couponsApi.setCustomerType(v.leadId, v.customerType));
