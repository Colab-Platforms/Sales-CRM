import type { OrderDetail } from "./api-client/types/orders.types";

// The payment figures of an order, labelled so they stay understandable after a refund. The underlying accounting is unchanged:
//   original paid  = what customers paid (every successful, partly refunded or fully refunded payment, at its ORIGINAL amount)
//   refunded       = what has been returned to the customer
//   net paid       = original paid - refunded = the money the business still holds (this is why it reads 0.00 after a full refund)
//   refundable now = what a new refund may still ask for (an active order is refundable: the manager's approval cancels it)

const PAID_STATES = new Set(["SUCCESS", "PARTIALLY_REFUNDED", "REFUNDED"]);
const cents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100) || 0;
const text = (c: number) => (c / 100).toFixed(2);

export interface PaymentFigures {
  orderAmount: string;
  originalPaid: string;
  refunded: string;
  netPaid: string;
  refundableNow: string;
  outstanding: string;
}

export function paymentFigures(order: Pick<OrderDetail, "status" | "totalAmount" | "paidAmount" | "refundedAmount" | "outstandingAmount" | "payments"> & { refunds?: OrderDetail["refunds"] }): PaymentFigures {
  const originalPaid = order.payments.filter((p) => PAID_STATES.has(p.status)).reduce((sum, p) => sum + cents(p.amount), 0);
  const refundable = (order.refunds?.payments ?? []).filter((p) => p.eligible).reduce((sum, p) => sum + cents(p.refundableAmount), 0);
  return {
    orderAmount: text(cents(order.totalAmount)),
    originalPaid: text(originalPaid),
    refunded: text(cents(order.refundedAmount)),
    netPaid: text(cents(order.paidAmount)),
    refundableNow: text(refundable),
    outstanding: text(cents(order.outstandingAmount)),
  };
}
