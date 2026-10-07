// Prepaid Upgrade (COD -> prepaid at a telecaller-offered discount). Mirrors backend orders.prepaid-upgrade.*.
export type UpgradeStatus = "OFFERED" | "PAYMENT_PENDING" | "PAYMENT_RECEIVED" | "UPGRADED" | "DECLINED";

export interface PrepaidUpgradeOffer {
  id: string;
  status: UpgradeStatus;
  currency: string;
  /** The COD amount when the offer was made. */
  originalAmount: string;
  discountType: "FIXED" | "PERCENT";
  discountValue: string;
  discountAmount: string;
  prepaidAmount: string;
  createdById: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  paymentId: string | null;
  paymentUrl: string | null;
  paidAt: string | null;
  upgradedAt: string | null;
  lastPaymentFailure: { reason: string; at: string } | null;
  note: string | null;
  orderSource?: string | null;
  shopifyOrderId?: string | null;
  shopifyOrderNumber?: string | null;
  originalDiscountAmount?: string | null;
}

export interface PrepaidUpgradeView {
  /** The CRM order id once one exists; null for a Shopify order the CRM has not seen yet (the first offer creates it). */
  orderId: string | null;
  eligible: boolean;
  /** Shopify side of a converted upgrade, distinct from "payment received". */
  shopifyReconciliation: "COMPLETED" | "PENDING" | "FAILED" | "NOT_APPLICABLE";
  /** COD by the CRM's own rule, whether or not it can be upgraded right now (so the card can explain WHY it can't). */
  isCod: boolean;
  reason: string | null;
  orderAmount: string;
  currency: string;
  offer: PrepaidUpgradeOffer | null;
  history: PrepaidUpgradeOffer[];
}

export interface PrepaidUpgradeActionResult extends PrepaidUpgradeView {
  reused: boolean;
  /** The Payment to hand to the existing "send payment link on WhatsApp" action. */
  paymentId: string | null;
}

export interface CreatePrepaidUpgradeInput {
  /** A Fastrr coupon code, OR a custom discountType + discountValue. */
  couponCode?: string;
  discountType?: "FIXED" | "PERCENT";
  /** What the telecaller typed - the server computes every amount from it. */
  discountValue?: string;
  /** Consistency check only: refused (409) if the server's prepaid amount differs. */
  expectedPrepaidAmount?: string;
}
