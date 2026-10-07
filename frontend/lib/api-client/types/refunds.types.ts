// Kept in sync with backend/src/modules/refunds/refunds.types.ts. Refund APPROVAL workflow: an APPROVED request authorizes a later refund;
// nothing here means money has been returned.
import type { PaymentMethod, PaymentStatus } from "./orders.types";
import type { Role } from "./auth.types";

export type RefundRequestStatus = "PENDING" | "APPROVED" | "REJECTED";

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
  ineligibleReason: string | null;
}

export interface OrderRefundInfo {
  payments: RefundablePaymentView[];
  requests: RefundRequestView[];
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
