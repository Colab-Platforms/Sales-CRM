import type { CreateManualOrderResult } from "@/lib/api-client/types/orders.types";

// "Payment already received": the customer paid OUTSIDE Cashfree (a personal / company UPI QR, ...). The order is created as paid and no payment link or QR is made. The server decides everything
// (role, prepaid-only, who confirmed, when); this file only shapes the request and the wording.

export const EXTERNAL_PAYMENT_LABEL = "Payment already received";
export const EXTERNAL_PAYMENT_HELP = "Select this if the customer has already paid through a personal/company UPI QR code or another payment method.";
export const EXTERNAL_PAYMENT_NOTE = "Order will be created as paid. No payment link or QR will be sent, and the payment is recorded as confirmed by you - not verified by Cashfree.";
export const EXTERNAL_PAYMENT_ROLES = ["ADMIN", "MANAGER", "SALESPERSON"];

/** Whether the checkbox is offered: prepaid orders only (never COD), to the roles the server allows (the server re-checks). */
export const canMarkPaymentReceived = (orderType: string, role: string | undefined): boolean => orderType !== "COD" && Boolean(role) && EXTERNAL_PAYMENT_ROLES.includes(role!);

/** The request fields: nothing at all unless the box is ticked on a prepaid order, so an unticked box sends exactly what was sent before. The reference is optional and trimmed. */
export function externalPaymentFields(orderType: string, received: boolean, reference: string): { paymentAlreadyReceived?: true; paymentReference?: string } {
  if (orderType === "COD" || !received) return {};
  const ref = reference.trim().slice(0, 100);
  return { paymentAlreadyReceived: true, ...(ref ? { paymentReference: ref } : {}) };
}

/** What the result screen says about the payment of an externally paid order, and whether something needs attention (Shopify did not get the order or its paid status). */
export function externalPaymentOutcome(result: Pick<CreateManualOrderResult, "shopify" | "manualPayment">): { text: string; warn: boolean } | null {
  const m = result.manualPayment;
  if (!m) return null;
  const ref = m.reference ? ` · Reference ${m.reference}` : "";
  if (result.shopify.status === "failed") return { text: `Payment recorded as received${ref}. Shopify did not accept the order: ${result.shopify.reason ?? "unknown reason"}. Retry the Shopify sync - nothing will be created twice.`, warn: true };
  if (m.shopifyPayment !== "synced") return { text: `Payment recorded as received${ref}, but Shopify has not marked the order paid yet${m.shopifyReason ? `: ${m.shopifyReason}` : ""}. Retry the Shopify sync.`, warn: true };
  return { text: `Paid - confirmed by you outside Cashfree${ref}. Not a Cashfree-verified payment.`, warn: false };
}
