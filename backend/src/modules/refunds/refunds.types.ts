// Refund APPROVAL workflow (Phase 1A). Nothing in this module executes a refund: an APPROVED request only authorizes a later provider refund.
import type { OrderStatus, PaymentMethod, PaymentStatus, RefundExecutionStatus, RefundRequestStatus, Role } from "../../../generated/prisma/enums.js";

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
  orderStatus: OrderStatus;
  customer: { leadId: string; name: string; mobile: string | null };
  paymentId: string;
  paymentMethod: PaymentMethod | null;
  currency: string;
  /** The payment's own amount. */
  paymentAmount: string;
  /** Already refunded on the payment (Payment.refundedAmount). */
  refundedAmount: string;
  /** What this request asks for. */
  amount: string;
  /** What is still refundable on the payment after ALL active (pending/approved) requests, including this one. */
  remainingRefundableAmount: string;
  reason: string;
  status: RefundRequestStatus;
  requestedBy: RefundActor;
  decidedBy: RefundActor | null;
  decisionAt: Date | null;
  decisionNote: string | null;
  /** Provider execution state of an APPROVED request: null = not started. Separate from `status` (the approval decision). */
  executionStatus: RefundExecutionStatus | null;
  /** The refund_id sent to Cashfree (derived from the request id), once execution has started. */
  refundId: string | null;
  cfRefundId: string | null;
  providerStatus: string | null;
  executionStartedAt: Date | null;
  executionCompletedAt: Date | null;
  executedBy: RefundActor | null;
  failureReason: string | null;
  createdAt: Date;
}

export interface RefundablePaymentView {
  paymentId: string;
  method: PaymentMethod | null;
  status: PaymentStatus;
  currency: string;
  amount: string;
  refundedAmount: string;
  /** Held by pending/approved requests. */
  reservedAmount: string;
  /** What a NEW request may still ask for: the CRM's balance, and for a Shopify payment never more than Shopify's own remaining refundable amount. */
  refundableAmount: string;
  /** Shopify's refundable amount for the order as last read from Shopify (Shopify-originated payments only; null when not applicable or not known). */
  shopifyRefundableAmount: string | null;
  /** true when Shopify's figure, not the CRM's balance, is what limits refundableAmount. */
  limitedByShopify: boolean;
  eligible: boolean;
  /** Not refundable only because its Cashfree payment is not (yet) verified (a Shopify-synced Cashfree payment): verification runs automatically after sync; it can be retried. */
  canResolve: boolean;
  /** Why a refund request is not possible for this payment (null when eligible). */
  ineligibleReason: string | null;
}

export interface OrderRefundInfo {
  /** The order's status (a refund needs CANCELLED); null only if the order could not be read. */
  orderStatus: OrderStatus | null;
  payments: RefundablePaymentView[];
  requests: RefundRequestView[];
}

export interface ListRefundRequestsQuery {
  status: RefundRequestStatus | "ALL";
  orderId?: string;
  requestedById?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export interface RefundRequestListResult {
  items: RefundRequestView[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}
