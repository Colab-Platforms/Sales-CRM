// Kept in sync with backend/src/modules/refunds/refunds.types.ts. Refund APPROVAL workflow: an APPROVED request authorizes a later refund;
// nothing here means money has been returned.
import type { PaymentMethod, PaymentStatus } from "./orders.types";
import type { Role } from "./auth.types";

export type RefundRequestStatus = "PENDING" | "APPROVED" | "REJECTED";
/** Provider execution of an APPROVED request; null/undefined = not started. Separate from the approval decision. */
export type RefundExecutionStatus = "PROCESSING" | "COMPLETED" | "FAILED";

export interface RefundActor {
  id: string;
  name: string;
  role: Role;
}

export interface RefundRequestView {
  id: string;
  orderId: string;
  orderNumber: string;
  /** The order's status: a refund can only be approved / executed while it is CANCELLED. */
  orderStatus?: string;
  customer: { leadId: string; name: string; mobile: string | null };
  paymentId: string;
  paymentMethod: PaymentMethod | null;
  currency: string;
  paymentAmount: string;
  refundedAmount: string;
  amount: string;
  /** Still refundable on the payment after ALL open (pending/approved) requests, including this one. */
  remainingRefundableAmount: string;
  reason: string;
  status: RefundRequestStatus;
  requestedBy: RefundActor;
  decidedBy: RefundActor | null;
  decisionAt: string | null;
  decisionNote: string | null;
  executionStatus?: RefundExecutionStatus | null;
  refundId?: string | null;
  cfRefundId?: string | null;
  providerStatus?: string | null;
  executionStartedAt?: string | null;
  executionCompletedAt?: string | null;
  executedBy?: RefundActor | null;
  failureReason?: string | null;
  createdAt: string;
}

export interface RefundablePaymentView {
  paymentId: string;
  method: PaymentMethod | null;
  status: PaymentStatus;
  currency: string;
  amount: string;
  refundedAmount: string;
  reservedAmount: string;
  refundableAmount: string;
  eligible: boolean;
  /** Not refundable yet only because its Cashfree references are not looked up (a Shopify-synced Cashfree payment). */
  canResolve?: boolean;
  /** Shopify's refundable amount for the order as last read from Shopify (Shopify-originated payments only). */
  shopifyRefundableAmount?: string | null;
  /** true when Shopify's refundable amount, not the CRM's balance, is what limits refundableAmount. */
  limitedByShopify?: boolean;
  ineligibleReason: string | null;
}

export interface OrderRefundInfo {
  /** The order's status (a refund needs CANCELLED). */
  orderStatus?: string | null;
  payments: RefundablePaymentView[];
  requests: RefundRequestView[];
}

export interface ResolveCashfreeResult {
  resolved: boolean;
  reason: string | null;
}

export interface CreateRefundRequestInput {
  paymentId: string;
  amount: string;
  reason: string;
  /** One id per submission, so a double click / retry returns the same request instead of creating another. */
  submissionKey: string;
}

export interface RefundQueueParams {
  status?: RefundRequestStatus | "ALL";
  page?: number;
  pageSize?: number;
}

export interface RefundQueueResult {
  items: RefundRequestView[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}
