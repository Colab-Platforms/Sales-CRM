import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";

export type CouponEligibility = "ALL" | "REGULAR" | "DISTRIBUTOR";
export type CustomerType = "REGULAR" | "DISTRIBUTOR";

export interface Coupon {
  id: string;
  code: string;
  discountType: "FIXED" | "PERCENT";
  discountValue: string;
  eligibility: CouponEligibility;
  minOrderValue: string | null;
  maxDiscount: string | null;
  isActive: boolean;
  usedByOrders: number;
}

export interface CouponInput {
  code: string;
  discountType: "FIXED" | "PERCENT";
  discountValue: string;
  eligibility: CouponEligibility;
  minOrderValue: string | null;
  maxDiscount: string | null;
  isActive?: boolean;
}

export const couponsApi = {
  async list(): Promise<Coupon[]> {
    return (await apiClient.get<ApiEnvelope<Coupon[]>>("/coupons")).data.data;
  },
  async create(input: CouponInput): Promise<Coupon> {
    return (await apiClient.post<ApiEnvelope<Coupon>>("/coupons", input)).data.data;
  },
  async update(id: string, input: CouponInput): Promise<Coupon> {
    return (await apiClient.put<ApiEnvelope<Coupon>>(`/coupons/${id}`, input)).data.data;
  },
  async setActive(id: string, isActive: boolean): Promise<Coupon> {
    return (await apiClient.patch<ApiEnvelope<Coupon>>(`/coupons/${id}/active`, { isActive })).data.data;
  },
  async remove(id: string): Promise<{ deleted: "hard" | "soft" }> {
    return (await apiClient.delete<ApiEnvelope<{ deleted: "hard" | "soft" }>>(`/coupons/${id}`)).data.data;
  },
  async setCustomerType(leadId: string, customerType: CustomerType): Promise<{ leadId: string; customerType: CustomerType }> {
    return (await apiClient.patch<ApiEnvelope<{ leadId: string; customerType: CustomerType }>>(`/coupons/customer-type/${leadId}`, { customerType })).data.data;
  },
};
