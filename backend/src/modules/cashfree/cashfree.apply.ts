import { ActivitySource, ActivityType, PaymentMethod, PaymentStatus, type Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { computePaymentBreakdown } from "../orders/orders.filters.js";
import { deriveReconciliationStatus } from "../reconciliation/reconciliation.filters.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { advisoryLock, asRecord, type Db } from "../integrations/integrations.common.js";
import { confirmBookingOrderAfterPayment } from "../orders/orders.booking.conversion.js";

// The single place a Cashfree result is applied to a CRM Payment row. Both the webhook processor and the manual
// "refresh" action go through it, so they can never disagree about what a status change means.
//
// Rules:
//  - Only rows the CRM created through Cashfree (externalSource CASHFREE) are ever touched. A webhook never creates a
//    payment, so Shopify-derived payments and Cashfree events can not be counted twice.
//  - Status only moves forward. A late or repeated "failed" can never undo SUCCESS, and nothing here ever refunds.
//  - Everything for one order runs under one advisory lock, shared with link creation and cancellation.

export const PAYMENT_REFERENCE_TYPE = "Payment";
export const ORDER_REFERENCE_TYPE = "Order";
export const orderLockKey = (orderId: string) => `cashfree:order:${orderId}`;

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return false;
  switch (to) {
    // A link can be paid moments before it expires, so a payment already marked expired may still turn out paid.
    case PaymentStatus.SUCCESS:
      return from === PaymentStatus.PENDING || from === PaymentStatus.PROCESSING || from === PaymentStatus.FAILED;
    case PaymentStatus.FAILED:
      return from === PaymentStatus.PENDING || from === PaymentStatus.PROCESSING;
    case PaymentStatus.PROCESSING:
      return from === PaymentStatus.PENDING;
    default:
      return false;
  }
}

export interface PaymentUpdate {
  /** The status Cashfree reports, or null to only record details. */
  status: "SUCCESS" | "FAILED" | "PROCESSING" | null;
  /** What Cashfree says was actually paid; if it differs from the link amount the real figure is stored and a mismatch is recorded. */
  paidAmount?: string | null;
  method?: PaymentMethod | null;
  cfPaymentId?: string | null;
  bankReference?: string | null;
  paidAt?: Date | null;
  failureReason?: string | null;
  /** Provider-side facts to keep on the row (never credentials). */
  meta?: Record<string, unknown>;
  /** Overrides the audit event written for a status change, e.g. a cancellation. */
  activity?: { type: ActivityType; title: string };
}

/** What a fetched link means for the CRM payment. */
export function linkToUpdate(link: { linkStatus: string; linkAmountPaid: string | null }): PaymentUpdate {
  switch (link.linkStatus) {
    case "PAID":
      return { status: "SUCCESS", paidAmount: link.linkAmountPaid, meta: { linkStatus: link.linkStatus } };
    case "EXPIRED":
      return { status: "FAILED", failureReason: "Payment link expired", meta: { linkStatus: link.linkStatus } };
    case "CANCELLED":
      return { status: "FAILED", failureReason: "Payment link cancelled", meta: { linkStatus: link.linkStatus } };
    case "PARTIALLY_PAID":
      // Links are created without partial payments, so this is unexpected; it is surfaced rather than treated as paid.
      return { status: "PROCESSING", meta: { linkStatus: link.linkStatus, amountPaid: link.linkAmountPaid } };
    default:
      return { status: null, meta: { linkStatus: link.linkStatus } };
  }
}

export interface ApplyContext {
  source: ActivitySource;
  actor?: { id: string; role: Role } | null;
  now?: Date;
}

export type ApplyResult =
  | { outcome: "not_found" }
  | { outcome: "unchanged"; orderId: string; leadId: string }
  | { outcome: "updated"; orderId: string; leadId: string; from: PaymentStatus; to: PaymentStatus };

export async function applyPaymentUpdate(tx: Db, paymentId: string, update: PaymentUpdate, ctx: ApplyContext): Promise<ApplyResult> {
  const now = ctx.now ?? new Date();
  const head = await tx.payment.findUnique({ where: { id: paymentId }, select: { orderId: true } });
  if (!head) return { outcome: "not_found" };
  await advisoryLock(tx, orderLockKey(head.orderId));

  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      orderId: true,
      status: true,
      amount: true,
      method: true,
      externalSource: true,
      externalId: true,
      providerPaymentId: true,
      transactionReference: true,
      metadata: true,
      order: { select: { leadId: true, orderNumber: true, totalAmount: true, payments: { select: { id: true, status: true, amount: true, refundedAmount: true } } } },
    },
  });
  if (!payment || payment.externalSource !== "CASHFREE") return { outcome: "not_found" };
  const { leadId, orderNumber } = payment.order;
  const unchanged: ApplyResult = { outcome: "unchanged", orderId: payment.orderId, leadId };

  const from = payment.status;
  const to = update.status ? (PaymentStatus[update.status] as PaymentStatus) : null;
  const moves = to !== null && canTransition(from, to);
  const finalStatus = moves ? to : from;

  const data: Prisma.PaymentUncheckedUpdateInput = {};
  if (moves) data.status = to;

  const settled = finalStatus === PaymentStatus.SUCCESS;
  // Fill in details Cashfree knows and the row does not. A real method replaces the generic "payment link" one.
  if (settled && update.cfPaymentId && !payment.providerPaymentId) data.providerPaymentId = update.cfPaymentId.slice(0, 255);
  if (settled && !payment.transactionReference && (update.bankReference || update.cfPaymentId)) data.transactionReference = (update.bankReference ?? update.cfPaymentId)!.slice(0, 255);
  if (settled && update.method && (payment.method === null || payment.method === PaymentMethod.PAYMENT_LINK) && update.method !== payment.method) data.method = update.method;

  let mismatch: { expected: string; paid: string } | null = null;
  if (moves && to === PaymentStatus.SUCCESS) {
    data.paidAt = update.paidAt ?? now;
    data.failedAt = null;
    data.failureReason = null;
    const paid = update.paidAmount ? toCents(update.paidAmount) : null;
    if (paid !== null && paid > 0 && paid !== toCents(payment.amount.toString())) {
      mismatch = { expected: payment.amount.toString(), paid: fromCents(paid) };
      data.amount = fromCents(paid);
    }
  } else if (moves && to === PaymentStatus.FAILED) {
    data.failedAt = now;
    data.failureReason = (update.failureReason ?? "Payment did not complete").slice(0, 500);
  }

  const detailsChanged = Object.keys(data).length > (moves ? 1 : 0);
  if (update.meta || moves || detailsChanged) {
    const existing = asRecord(payment.metadata);
    data.metadata = { ...existing, cashfree: { ...asRecord(existing.cashfree), ...(update.meta ?? {}), lastEventAt: now.toISOString() } } as Prisma.InputJsonValue;
  }
  if (!moves && !detailsChanged && !update.meta) return unchanged;

  await tx.payment.update({ where: { id: payment.id }, data });
  if (!moves) return { outcome: "unchanged", orderId: payment.orderId, leadId };

  const base = { leadId, orderId: payment.orderId, actorId: ctx.actor?.id ?? null, actorRole: ctx.actor?.role ?? null, source: ctx.source };
  const rows: Prisma.ActivityCreateManyInput[] = [
    {
      ...base,
      type: update.activity?.type ?? ActivityType.PAYMENT_STATUS_CHANGED,
      referenceType: PAYMENT_REFERENCE_TYPE,
      referenceId: payment.id,
      title: update.activity?.title ?? `Payment ${finalStatus.toLowerCase().replace("_", " ")} (Cashfree)`,
      description: `${from} -> ${finalStatus}`,
      oldValue: { status: from },
      newValue: { status: finalStatus, amount: (data.amount as string | undefined) ?? payment.amount.toString(), method: (data.method as PaymentMethod | undefined) ?? payment.method },
      metadata: { provider: "CASHFREE", linkId: payment.externalId },
      createdAt: now,
    },
  ];

  if (mismatch) {
    rows.push({
      ...base,
      type: ActivityType.PAYMENT_MISMATCH_DETECTED,
      referenceType: PAYMENT_REFERENCE_TYPE,
      referenceId: payment.id,
      title: `Cashfree reported a different amount than the payment link (order ${orderNumber})`,
      metadata: { provider: "CASHFREE", linkAmount: mismatch.expected, amountPaid: mismatch.paid },
      createdAt: now,
    });
  }

  if (finalStatus === PaymentStatus.SUCCESS) {
    // The order may already have been paid another way (for instance through Shopify checkout) while the link was open.
    // The money really arrived, so it is recorded; the over-collection is reported instead of hidden.
    const all = payment.order.payments.map((p) => (p.id === payment.id ? { ...p, status: PaymentStatus.SUCCESS, amount: (data.amount as string | undefined) ?? p.amount } : p));
    const breakdown = computePaymentBreakdown(all);
    const total = toCents(payment.order.totalAmount.toString());
    if (deriveReconciliationStatus(total, breakdown, all.length > 0) === "PAYMENT_MISMATCH") {
      rows.push({
        ...base,
        type: ActivityType.PAYMENT_MISMATCH_DETECTED,
        referenceType: ORDER_REFERENCE_TYPE,
        referenceId: payment.orderId,
        title: `Payment mismatch detected for order ${orderNumber}`,
        metadata: { orderTotal: payment.order.totalAmount.toString(), netPaid: fromCents(breakdown.paidCents), refunded: fromCents(breakdown.refundedCents) },
        createdAt: now,
      });
    }
  }

  await tx.activity.createMany({ data: rows });
    // E5: an on-call payment-link order is confirmed (and its lead converted) the moment its payment succeeds.
  if (finalStatus === PaymentStatus.SUCCESS) {
    await confirmBookingOrderAfterPayment(tx, payment.orderId, ctx.actor?.id ?? null);
  }
  return { outcome: "updated", orderId: payment.orderId, leadId, from, to: finalStatus };
}
