import type { PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";
import type { PaymentMode, PaymentStatusFilter } from "../orders/orders.types.js";

// Decimal columns are sent as strings so no precision is lost in JSON.
type Money = string;

// Derived per order from its real payments, never stored:
//   PAID               net paid covers the order total
//   PARTIALLY_PAID      some money paid, less than the order total
//   PENDING             no successful payment yet (including no payment at all)
//   FAILED              every payment attempt failed, nothing paid or refunded
//   REFUNDED            fully refunded, nothing currently held
//   PAYMENT_MISMATCH    the numbers are inconsistent (refunded more than collected, or paid more
//                        than the order is worth) - never used just because data is missing
export type ReconciliationStatus = "PAID" | "PARTIALLY_PAID" | "PENDING" | "FAILED" | "REFUNDED" | "PAYMENT_MISMATCH";

export interface ListReconciliationQuery {
  page: number;
  pageSize: number;
  search?: string;
  paymentStatus?: PaymentStatusFilter;
  paymentMode?: PaymentMode;
  reconciliationStatus?: ReconciliationStatus;
  provider?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface ReconciliationOrderRow {
  id: string;
  orderNumber: string;
  externalNumber: string | null;
  createdAt: Date;
  currency: string;
  customer: { leadId: string; leadNumber: string; name: string };
  orderAmount: Money;
  discountAmount: Money;
  paidAmount: Money;
  refundedAmount: Money;
  outstandingAmount: Money;
  paymentMode: PaymentMode | null;
  paymentMethod: PaymentMethod | null;
  paymentStatus: PaymentStatus | null;
  paymentProvider: string | null;
  transactionReference: string | null;
  reconciliationStatus: ReconciliationStatus;
}

export interface ReconciliationSummary {
  orderCount: number;
  grossOrderValue: Money;
  successfulPayments: Money;
  pendingPayments: Money;
  failedPayments: Money;
  refundedAmount: Money;
  netRevenue: Money;
  outstandingAmount: Money;
  codOrderCount: number;
  codValue: Money;
  prepaidOrderCount: number;
  prepaidValue: Money;
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
