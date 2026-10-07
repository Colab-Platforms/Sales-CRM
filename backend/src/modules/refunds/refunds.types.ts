// Refund APPROVAL workflow (Phase 1A). Nothing in this module executes a refund: an APPROVED request only authorizes a later provider refund.
import type { PaymentMethod, PaymentStatus, RefundRequestStatus, Role } from "../../../generated/prisma/enums.js";

export interface RefundActor {
  id: string;
  name: string;
  role: Role;
}

export interface RefundRequestView {
  id: string;
  orderId: string;
  orderNumber: string;
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
  /** What a NEW request may still ask for. */
  refundableAmount: string;
  eligible: boolean;
  /** Why a refund request is not possible for this payment (null when eligible). */
  ineligibleReason: string | null;
}

export interface OrderRefundInfo {
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
