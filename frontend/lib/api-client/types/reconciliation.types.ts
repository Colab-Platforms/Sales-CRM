import type { PaymentMethod, PaymentMode, PaymentStatus, PaymentStatusFilter } from "./orders.types";

// Derived per order from its real payments, never stored:
//   PAID               net paid covers the order total
//   PARTIALLY_PAID      some money paid, less than the order total
//   PENDING             no successful payment yet (including no payment at all)
//   FAILED              every payment attempt failed, nothing paid or refunded
//   REFUNDED            fully refunded, nothing currently held
//   PAYMENT_MISMATCH    the numbers are inconsistent - never used just because data is missing
export type ReconciliationStatus = "PAID" | "PARTIALLY_PAID" | "PENDING" | "FAILED" | "REFUNDED" | "PAYMENT_MISMATCH";

export interface ReconciliationListParams {
  page: number;
  pageSize: number;
  search?: string;
  paymentStatus?: PaymentStatusFilter;
  paymentMode?: PaymentMode;
  reconciliationStatus?: ReconciliationStatus;
  provider?: string;
  // ISO date-times
  dateFrom?: string;
  dateTo?: string;
}

export interface ReconciliationOrderRow {
  id: string;
  orderNumber: string;
  externalNumber: string | null;
  createdAt: string;
  currency: string;
  customer: { leadId: string; leadNumber: string; name: string };
  orderAmount: string;
  discountAmount: string;
  paidAmount: string;
  refundedAmount: string;
  outstandingAmount: string;
  paymentMode: PaymentMode | null;
  paymentMethod: PaymentMethod | null;
  paymentStatus: PaymentStatus | null;
  paymentProvider: string | null;
  transactionReference: string | null;
  reconciliationStatus: ReconciliationStatus;
}

export interface ReconciliationSummary {
  orderCount: number;
  grossOrderValue: string;
  successfulPayments: string;
  pendingPayments: string;
  failedPayments: string;
  refundedAmount: string;
  netRevenue: string;
  outstandingAmount: string;
  codOrderCount: number;
  codValue: string;
  prepaidOrderCount: number;
  prepaidValue: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface ReconciliationResult {
  summary: ReconciliationSummary;
  items: ReconciliationOrderRow[];
  pagination: Pagination;
}
