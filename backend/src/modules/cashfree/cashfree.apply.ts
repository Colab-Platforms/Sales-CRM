import { ActivitySource, ActivityType, OrderStatus, PaymentMethod, PaymentStatus, type Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { computePaymentBreakdown } from "../orders/orders.filters.js";
import { deriveReconciliationStatus } from "../reconciliation/reconciliation.filters.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { advisoryLock, asRecord, type Db } from "../integrations/integrations.common.js";
import { onPrepaidUpgradePayment } from "../orders/orders.prepaid-upgrade.hooks.js";

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

/**
 * Cashfree reports a link as paid (or a delivery claims a payment) for an amount that is NOT the amount the CRM expects. It is never applied as paid - but it must not vanish into a log
 * line either: the money may really have moved, so an admin has to see it. Writes ONE audit row per payment and distinct reported amount (a retried delivery or a second Refresh adds
 * nothing) and leaves the payment's status exactly as it was.
 */
export async function recordAmountMismatch(tx: Db, paymentId: string, info: { expected: string; reported: string; via: "webhook" | "refresh"; source: ActivitySource; now?: Date }): Promise<"recorded" | "already_recorded" | "not_found"> {
  const now = info.now ?? new Date();
  const head = await tx.payment.findUnique({ where: { id: paymentId }, select: { orderId: true } });
  if (!head) return "not_found";
  await advisoryLock(tx, orderLockKey(head.orderId));
  const payment = await tx.payment.findUnique({ where: { id: paymentId }, select: { id: true, orderId: true, externalSource: true, externalId: true, order: { select: { leadId: true, orderNumber: true } } } });
  if (!payment || payment.externalSource !== "CASHFREE") return "not_found";
  const already = await tx.activity.findFirst({
    where: { orderId: payment.orderId, type: ActivityType.PAYMENT_MISMATCH_DETECTED, referenceType: PAYMENT_REFERENCE_TYPE, referenceId: payment.id, metadata: { path: ["reportedAmount"], equals: info.reported } },
    select: { id: true },
  });
  if (already) return "already_recorded";
  await tx.activity.create({
    data: {
      leadId: payment.order.leadId,
      orderId: payment.orderId,
      source: info.source,
      type: ActivityType.PAYMENT_MISMATCH_DETECTED,
      referenceType: PAYMENT_REFERENCE_TYPE,
      referenceId: payment.id,
      title: `Cashfree reported ${info.reported} for a payment link of ${info.expected} - not applied as paid (order ${payment.order.orderNumber})`,
      description: "The payment was NOT marked paid because the amount differs from the link. Check the Cashfree dashboard for this link and resolve it manually.",
      metadata: { provider: "CASHFREE", linkId: payment.externalId, linkAmount: info.expected, reportedAmount: info.reported, via: info.via, applied: false } as Prisma.InputJsonValue,
      createdAt: now,
    },
  });
  return "recorded";
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
  | { outcome: "unchanged"; orderId: string; leadId: string; /** Set when a verified SUCCESS was NOT applied as a normal payment but recorded as an exception for refund / review. */ exception?: PaymentException }
  | { outcome: "updated"; orderId: string; leadId: string; from: PaymentStatus; to: PaymentStatus };

export type PaymentException = "duplicate" | "late";
const CLOSED_ORDER = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.RETURNED]);

interface SuccessSubject {
  id: string;
  orderId: string;
  status: PaymentStatus;
  amount: { toString(): string };
  providerPaymentId: string | null;
  failureReason: string | null;
  paymentExpiresAt: Date | null;
  metadata: unknown;
  order: { leadId: string; orderNumber: string; status: OrderStatus };
}

/**
 * A verified SUCCESS that must NOT be applied as the order's normal payment, but must not vanish either:
 *  - DUPLICATE: the payment is already SUCCESS and this is a DIFFERENT Cashfree payment / order (the customer paid through the payment link AND the UPI QR). The first one stays the payment of record.
 *  - LATE: money arrived for a payment the CRM had ALREADY CLOSED (FAILED) because its order was cancelled / refunded / returned, because the payment was cancelled, or (for the UPI QR) because it expired. A payment that is still OPEN when its order is cancelled keeps its existing handling: it is recorded as received, the order is never reactivated, and the over-collection is reported. The order is never confirmed, shipped to Shopify or marked paid by it.
 * Either is written ONCE (keyed by the Cashfree payment / order id, so a repeated or concurrent delivery adds nothing): an audit row the admins see, and an entry in Order.metadata.paymentExceptions marked
 * NEEDS_REFUND. No Payment row is created and no status moves; refunding stays a deliberate, manual decision.
 * A repeat of the SAME payment (same ids, or no ids to tell it apart) is the ordinary idempotent case and returns null.
 */
async function recordSuccessException(tx: Db, payment: SuccessSubject, update: PaymentUpdate, ctx: ApplyContext, now: Date): Promise<PaymentException | null> {
  const cashfree = asRecord(asRecord(payment.metadata).cashfree);
  const incomingPayment = update.cfPaymentId ?? null;
  const incomingOrder = typeof update.meta?.cashfreeOrderId === "string" ? update.meta.cashfreeOrderId : null;
  const storedOrder = typeof cashfree.cashfreeOrderId === "string" ? cashfree.cashfreeOrderId : null;

  let kind: PaymentException | null = null;
  if (payment.status === PaymentStatus.SUCCESS) {
    const differs = (incomingPayment && payment.providerPaymentId && incomingPayment !== payment.providerPaymentId) || (incomingOrder && storedOrder && incomingOrder !== storedOrder && incomingOrder.startsWith("qr_") !== storedOrder.startsWith("qr_"));
    if (differs) kind = "duplicate";
  } else if (payment.status === PaymentStatus.FAILED && CLOSED_ORDER.has(payment.order.status)) kind = "late";
  else if (payment.status === PaymentStatus.FAILED && /cancel/i.test(payment.failureReason ?? "")) kind = "late";
  else if (payment.status === PaymentStatus.FAILED && update.meta?.via === "upi_qr" && payment.paymentExpiresAt && (update.paidAt ?? now) > payment.paymentExpiresAt) kind = "late";
  if (!kind) return null;

  const key = `${kind}:${incomingPayment ?? incomingOrder ?? payment.id}`;
  const already = await tx.activity.findFirst({
    where: { orderId: payment.orderId, type: ActivityType.PAYMENT_MISMATCH_DETECTED, referenceType: PAYMENT_REFERENCE_TYPE, referenceId: payment.id, metadata: { path: ["exceptionKey"], equals: key } },
    select: { id: true },
  });
  if (already) return kind;

  const amount = fromCents(toCents(update.paidAmount ?? payment.amount.toString()));
  const via = typeof update.meta?.via === "string" ? update.meta.via : incomingOrder && incomingOrder.startsWith("qr_") ? "upi_qr" : "payment_link";
  await tx.activity.create({
    data: {
      leadId: payment.order.leadId,
      orderId: payment.orderId,
      actorId: ctx.actor?.id ?? null,
      actorRole: ctx.actor?.role ?? null,
      source: ctx.source,
      type: ActivityType.PAYMENT_MISMATCH_DETECTED,
      referenceType: PAYMENT_REFERENCE_TYPE,
      referenceId: payment.id,
      title: kind === "duplicate" ? `A second successful payment was received for order ${payment.order.orderNumber} - it needs a refund` : `A payment was received for order ${payment.order.orderNumber} after it was cancelled or its payment closed - it needs a refund`,
      description: "Cashfree confirmed this payment, but it was NOT applied to the order. Check the Cashfree dashboard and refund or reconcile it manually.",
      metadata: { provider: "CASHFREE", kind, exceptionKey: key, cfPaymentId: incomingPayment, cashfreeOrderId: incomingOrder, amount, via, needsRefund: true, paymentStatusAtArrival: payment.status, orderStatusAtArrival: payment.order.status } as Prisma.InputJsonValue,
      createdAt: now,
    },
  });
  const order = await tx.order.findUnique({ where: { id: payment.orderId }, select: { metadata: true } });
  const meta = asRecord(order?.metadata);
  const list = Array.isArray(meta.paymentExceptions) ? (meta.paymentExceptions as unknown[]) : [];
  await tx.order.update({
    where: { id: payment.orderId },
    data: { metadata: { ...meta, paymentExceptions: [...list, { kind, key, paymentId: payment.id, cfPaymentId: incomingPayment, cashfreeOrderId: incomingOrder, amount, via, at: now.toISOString(), status: "NEEDS_REFUND" }] } as Prisma.InputJsonValue },
  });
  return kind;
}

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
      failureReason: true,
      paymentExpiresAt: true,
      metadata: true,
      order: { select: { leadId: true, orderNumber: true, status: true, totalAmount: true, payments: { select: { id: true, status: true, amount: true, refundedAmount: true } } } },
    },
  });
  if (!payment || payment.externalSource !== "CASHFREE") return { outcome: "not_found" };
  const { leadId, orderNumber } = payment.order;
  const unchanged: ApplyResult = { outcome: "unchanged", orderId: payment.orderId, leadId };

  // A verified SUCCESS that is a second payment, or arrives for a cancelled order / cancelled payment, is recorded for refund and never applied as the order's payment.
  if (update.status === "SUCCESS") {
    const exception = await recordSuccessException(tx, payment, update, ctx, now);
    if (exception) return { ...unchanged, exception };
  }

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
  // Prepaid Upgrade: a verified SUCCESS converts the COD order; a FAILED/expired/cancelled link only reopens the offer.
  // Runs inside this same transaction and advisory lock, so a duplicate callback can never upgrade twice.
  if (finalStatus === PaymentStatus.SUCCESS || finalStatus === PaymentStatus.FAILED) {
    await onPrepaidUpgradePayment(tx, {
      orderId: payment.orderId,
      paymentId: payment.id,
      status: finalStatus,
      paidCents: toCents(((data.amount as string | undefined) ?? payment.amount.toString())),
      failureReason: (data.failureReason as string | undefined) ?? null,
      actorId: ctx.actor?.id ?? null,
      actorRole: ctx.actor?.role ?? null,
      source: ctx.source,
      now,
    });
  }
  return { outcome: "updated", orderId: payment.orderId, leadId, from, to: finalStatus };
}
