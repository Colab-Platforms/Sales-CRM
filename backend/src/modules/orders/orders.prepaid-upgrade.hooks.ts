import { ActivityType, OrderStatus, PaymentStatus, type ActivitySource, type Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { asRecord, type Db } from "../integrations/integrations.common.js";

// Prepaid Upgrade state lives in Order.metadata (no schema change): `prepaidUpgrade` is the current offer and
// `prepaidUpgradeHistory` the superseded ones. Lifecycle:
//   (none = NOT_OFFERED) -> OFFERED -> PAYMENT_PENDING -> UPGRADED
//                                   \-> DECLINED         \-> PAYMENT_RECEIVED (money arrived but the order could not be converted)
// A failed/expired/cancelled link sends PAYMENT_PENDING back to OFFERED. COD is only converted by a verified payment.
export type UpgradeStatus = "OFFERED" | "PAYMENT_PENDING" | "PAYMENT_RECEIVED" | "UPGRADED" | "DECLINED";

export interface PrepaidUpgradeOffer {
  id: string;
  status: UpgradeStatus;
  currency: string;
  /** The COD amount when the offer was made - never overwritten by creating an offer. */
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
  /** Why the link did not complete (failed/expired/cancelled), until a new link is generated. */
  lastPaymentFailure: { reason: string; at: string } | null;
  /** Set when money was received but the order could not be converted (e.g. it was cancelled meanwhile). */
  note: string | null;
  /** Where the order came from (CRM order source: SHOPIFY, SALESPERSON, ...) and, for Shopify orders, the Shopify reference - kept for audit/reconciliation. */
  orderSource?: string | null;
  shopifyOrderId?: string | null;
  shopifyOrderNumber?: string | null;
  /** The order's own discount before the upgrade, so the prepaid discount stays distinguishable from it. */
  originalDiscountAmount?: string | null;
  /** Which discount was chosen and why: a Fastrr coupon or a custom value (and whether it was the configured default). */
  couponId?: string | null;
  couponSource?: "FASTRR" | null;
  couponCode?: string | null;
  discountSource?: "FASTRR" | "CUSTOM";
  wasDefault?: boolean;
}

export const readOffer = (metadata: unknown): PrepaidUpgradeOffer | null => {
  const offer = asRecord(metadata).prepaidUpgrade;
  return offer && typeof offer === "object" ? (offer as PrepaidUpgradeOffer) : null;
};
export const readHistory = (metadata: unknown): PrepaidUpgradeOffer[] => {
  const h = asRecord(metadata).prepaidUpgradeHistory;
  return Array.isArray(h) ? (h as PrepaidUpgradeOffer[]) : [];
};

export interface UpgradePaymentEvent {
  orderId: string;
  paymentId: string;
  status: "SUCCESS" | "FAILED";
  paidCents: number;
  failureReason: string | null;
  actorId: string | null;
  actorRole: Role | null;
  source: ActivitySource;
  now: Date;
}

const BLOCKED = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.RETURNED]);

/**
 * Called by applyPaymentUpdate (already inside the order's advisory lock and transaction) after a Cashfree payment moves
 * to SUCCESS or FAILED. Ignores any payment that is not the current offer's own link.
 */
export async function onPrepaidUpgradePayment(tx: Db, e: UpgradePaymentEvent): Promise<void> {
  const order = await tx.order.findUnique({ where: { id: e.orderId }, select: { id: true, leadId: true, status: true, totalAmount: true, discountAmount: true, metadata: true } });
  if (!order) return;
  const meta = asRecord(order.metadata);
  const offer = readOffer(meta);
  if (!offer || offer.paymentId !== e.paymentId) return; // not an upgrade payment (or a superseded one)
  if (offer.status === "UPGRADED") return; // duplicate callback: never upgrade twice
  // The payment must carry THIS offer's id (stamped when its link was created): a success is only ever applied to the
  // exact request it belongs to, never to a different or older offer on the same order.
  const paymentRow = await tx.payment.findUnique({ where: { id: e.paymentId }, select: { metadata: true } });
  if (asRecord(paymentRow?.metadata).prepaidUpgradeId !== offer.id) return;

  const nowIso = e.now.toISOString();
  const base = { leadId: order.leadId, orderId: order.id, actorId: e.actorId, actorRole: e.actorRole, source: e.source, referenceType: "Order", referenceId: order.id, createdAt: e.now };

  if (e.status === "FAILED") {
    if (offer.status !== "PAYMENT_PENDING") return;
    const next: PrepaidUpgradeOffer = { ...offer, status: "OFFERED", paymentUrl: null, updatedAt: nowIso, lastPaymentFailure: { reason: (e.failureReason ?? "Payment did not complete").slice(0, 300), at: nowIso } };
    await tx.order.update({ where: { id: order.id }, data: { metadata: { ...meta, prepaidUpgrade: next } as unknown as Prisma.InputJsonValue } });
    await tx.activity.create({ data: { ...base, type: ActivityType.ORDER_STATUS_CHANGED, title: "Prepaid upgrade payment did not complete - order stays COD", description: next.lastPaymentFailure!.reason } });
    return;
  }

  // ---- SUCCESS: verified payment. Convert only if everything still lines up; otherwise record the money, not a conversion.
  const alreadyPrepaid = meta.paymentMode === "PREPAID";
  let blockedReason: string | null = null;
  if (BLOCKED.has(order.status)) blockedReason = `Payment received after the order was ${order.status.toLowerCase()}; the order was not converted.`;
  else if (alreadyPrepaid) blockedReason = "Payment received, but the order was already prepaid; it was not changed.";
  else if (e.paidCents !== toCents(offer.prepaidAmount)) blockedReason = `Paid ${fromCents(e.paidCents)} but the approved prepaid amount was ${offer.prepaidAmount}; the order was not converted.`;
  else if (toCents(order.totalAmount.toString()) !== toCents(offer.originalAmount)) blockedReason = "The order amount changed after the offer was made; the order was not converted.";

  if (blockedReason) {
    const next: PrepaidUpgradeOffer = { ...offer, status: "PAYMENT_RECEIVED", paidAt: nowIso, updatedAt: nowIso, note: blockedReason };
    await tx.order.update({ where: { id: order.id }, data: { metadata: { ...meta, prepaidUpgrade: next } as unknown as Prisma.InputJsonValue } });
    await tx.activity.create({ data: { ...base, type: ActivityType.PAYMENT_MISMATCH_DETECTED, title: "Prepaid upgrade payment received but order not converted", description: blockedReason } });
    return;
  }

  // The COD placeholder payment is retired (not deleted): it keeps its row and amount, its method is cleared so the
  // order's derived payment mode becomes PREPAID (the Cashfree payment carries a real method), and its history stays in metadata.
  const codRows = await tx.payment.findMany({ where: { orderId: order.id, method: "COD", status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] } }, select: { id: true, metadata: true } });
  for (const row of codRows) {
    await tx.payment.update({
      where: { id: row.id },
      data: { method: null, status: PaymentStatus.FAILED, failedAt: e.now, failureReason: "Replaced by prepaid upgrade", metadata: { ...asRecord(row.metadata), retiredByPrepaidUpgrade: { upgradeId: offer.id, originalMethod: "COD", at: nowIso } } as Prisma.InputJsonValue },
    });
  }

  const next: PrepaidUpgradeOffer = { ...offer, status: "UPGRADED", paidAt: nowIso, upgradedAt: nowIso, updatedAt: nowIso, note: null, originalDiscountAmount: order.discountAmount.toString() };
  await tx.order.update({
    where: { id: order.id },
    data: {
      discountAmount: fromCents(toCents(order.discountAmount.toString()) + toCents(offer.discountAmount)),
      totalAmount: offer.prepaidAmount,
      metadata: { ...meta, paymentMode: "PREPAID", prepaidUpgrade: next } as unknown as Prisma.InputJsonValue,
    },
  });
  await tx.activity.create({
    data: {
      ...base,
      type: ActivityType.ORDER_STATUS_CHANGED,
      title: "Prepaid upgrade completed: COD -> Prepaid",
      description: `Customer paid ${offer.prepaidAmount} (COD ${offer.originalAmount}, discount ${offer.discountAmount})`,
      oldValue: { paymentMode: "COD", totalAmount: offer.originalAmount },
      newValue: { paymentMode: "PREPAID", totalAmount: offer.prepaidAmount },
    },
  });
}
