import type { MarkPaidResult, OrderDetail } from "@/lib/api-client/types/orders.types";

// Roles the backend allows to record a payment verified outside Cashfree (the backend re-checks every call).
export const MANUAL_PAYMENT_ROLES = ["ADMIN", "MANAGER", "SALESPERSON"];

/** An unpaid, not-cancelled PREPAID order. COD is collected on delivery and never uses this. */
export function canMarkPaid(order: Pick<OrderDetail, "status" | "paymentMode" | "payments">, role: string | undefined): boolean {
  if (!role || !MANUAL_PAYMENT_ROLES.includes(role)) return false;
  if (order.paymentMode !== "PREPAID" || order.status === "CANCELLED") return false;
  return !order.payments.some((p) => p.status === "SUCCESS");
}

/** What the person is told after recording: Shopify problems are shown, never hidden. */
export function markPaidMessage(r: Pick<MarkPaidResult, "alreadyPaid" | "shopify">): { ok: boolean; text: string } {
  if (r.alreadyPaid) return { ok: true, text: "This order was already paid - nothing was changed." };
  if (r.shopify.paymentSync === "failed" || (!r.shopify.linked && r.shopify.reason)) {
    return { ok: false, text: `Payment recorded, but Shopify did not accept it: ${r.shopify.reason ?? "unknown reason"}. Use Retry Shopify sync on this order.` };
  }
  return { ok: true, text: "Payment recorded (verified outside Cashfree)." };
}
