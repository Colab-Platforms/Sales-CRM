import { z } from "zod";
import type { Response } from "express";
import { prisma } from "@/lib/prisma.js";
import { getOrderFlowScope } from "@/lib/leadScope.js";
import type { AuthRequest, AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, OrderStatus, PaymentMethod, PaymentStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { orderLockKey } from "../cashfree/cashfree.apply.js";
import { confirmAndSyncPaidOrder } from "../cashfree/cashfree.reconcile.js";
import { advisoryLock, asRecord, safeMessage, type Db, type TxRunner } from "../integrations/integrations.common.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import { recordConfirmation } from "./orders.confirmation.js";
import { scopedOrderWhere } from "./orders.filters.js";

// MANUAL PREPAID PAYMENT: a person verified that the customer paid OUTSIDE Cashfree (for example through the telecaller's own QR code) and records it.
//
//  - It is a SEPARATE, audited path. It never calls or imitates Cashfree: the payment row it creates has provider MANUAL, NO Cashfree source and NO Cashfree/provider id (it can never be mistaken for a Cashfree-verified
//    payment, and Cashfree refunds are refused for it). Who, when, why, the external reference and the previous state are written on the payment and in the order's Activity log.
//  - The existing Cashfree verification (webhook / refresh / catch-up) is untouched: a Cashfree result for the same order still works, and if BOTH happen the order's reconciliation flags the over-collection.
//  - Only an unpaid PREPAID order of this CRM can be marked: COD uses its own flow, a cancelled order is refused, and a paid order is never reverted (no reverse action exists here).
//  - Idempotent: marking an already-paid order creates no second payment and no second audit entry (it only finishes any follow-up that did not complete).
//  - Afterwards the same follow-up as a verified payment runs: the order is confirmed (attributed to the person who verified it), the Shopify order is created if there is none and marked paid (labelled as a manual
//    payment, not Cashfree). A Shopify problem is reported back and remembered on the order; it never undoes the recorded payment. Nothing here fulfils or ships anything.

export const MANUAL_PAYMENT_ROLES: Role[] = [Role.ADMIN, Role.MANAGER, Role.SALESPERSON];

export const markPaidSchema = z.object({
  /** Why the payment is believed to have arrived (required: this is a financial statement made by a person). */
  reason: z.string().trim().min(3, "Say how the payment was verified").max(300),
  /** The external payment reference (UTR / UPI transaction id / receipt number), when the person has one. */
  reference: z.string().trim().max(100).optional(),
});
export type MarkPaidInput = z.infer<typeof markPaidSchema>;

export interface MarkPaidResult {
  orderId: string;
  orderNumber: string;
  /** true = the order already had a successful payment: nothing new was recorded. */
  alreadyPaid: boolean;
  orderStatus: string;
  payment: { id: string; verification: "MANUAL_EXTERNAL" | "CASHFREE"; amount: string; paidAt: string | null };
  /** Shopify after the follow-up: the order link and the payment sync, with a reason when something did not go through. */
  shopify: { linked: boolean; paymentSync: "synced" | "failed" | "pending"; reason?: string };
  /** An unused Cashfree link of this order is still open (the customer could pay twice): cancel it from the order's payment link panel. */
  openCashfreeLink: boolean;
}

export async function markPrepaidOrderPaid(runner: TxRunner, user: AuthUser, orderId: string, rawInput: unknown, deps: { getShopifyClient?: () => ShopifyClient; now?: () => Date } = {}): Promise<MarkPaidResult> {
  if (!MANUAL_PAYMENT_ROLES.includes(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
  const parsed = markPaidSchema.safeParse(rawInput);
  if (!parsed.success) throw new ApiError(parsed.error.issues[0]?.message ?? "Invalid request", STATUS_CODES.BAD_REQUEST);
  const input = parsed.data;
  const now = (deps.now ?? (() => new Date()))();

  const recorded = await runner.$transaction(async (tx: Db) => {
    await advisoryLock(tx, orderLockKey(orderId));
    const scope = await getOrderFlowScope(user, tx as never);
    const order = await tx.order.findFirst({
      where: scopedOrderWhere(orderId, scope),
      select: { id: true, leadId: true, orderNumber: true, status: true, currency: true, totalAmount: true, metadata: true, payments: { select: { id: true, status: true, amount: true, provider: true, externalSource: true, paidAt: true, metadata: true } } },
    });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    const meta = asRecord(order.metadata);
    if (meta.paymentMode !== "PREPAID") throw new ApiError("Only a prepaid order can be marked as paid here. Cash on Delivery orders are collected on delivery.", STATUS_CODES.BAD_REQUEST);
    const openCashfreeLink = order.payments.some((p) => p.externalSource === "CASHFREE" && (p.status === PaymentStatus.PENDING || p.status === PaymentStatus.PROCESSING));

    const paid = order.payments.find((p) => p.status === PaymentStatus.SUCCESS);
    if (paid) {
      const manual = paid.provider === "MANUAL" && Boolean(asRecord(asRecord(paid.metadata).manual).verifiedById);
      return { order, alreadyPaid: true as const, payment: { id: paid.id, verification: manual ? ("MANUAL_EXTERNAL" as const) : ("CASHFREE" as const), amount: paid.amount.toString(), paidAt: paid.paidAt?.toISOString() ?? null }, openCashfreeLink };
    }
    if (order.status === OrderStatus.CANCELLED) throw new ApiError("This order is cancelled, so it cannot be marked as paid.", STATUS_CODES.CONFLICT);

    const actor = await tx.user.findUnique({ where: { id: user.id }, select: { id: true, name: true, username: true } });
    const actorName = (actor?.name?.trim() || actor?.username || user.username || "CRM user").slice(0, 150);
    const previous = order.payments.map((p) => ({ id: p.id, status: p.status, source: p.externalSource ?? p.provider ?? null }));
    const manual = { verifiedById: user.id, verifiedByName: actorName, verifiedByRole: user.role, verifiedAt: now.toISOString(), reason: input.reason, reference: input.reference ?? null, previousOrderStatus: order.status, previousPayments: previous, note: "Verified outside Cashfree - this is NOT a Cashfree-verified payment." };
    const payment = await tx.payment.create({
      data: { orderId, provider: "MANUAL", amount: order.totalAmount, currency: order.currency, method: PaymentMethod.OTHER, status: PaymentStatus.SUCCESS, transactionReference: input.reference ?? null, paidAt: now, metadata: { manual } as unknown as Prisma.InputJsonValue },
      select: { id: true },
    });
    await tx.order.update({ where: { id: orderId }, data: { metadata: { ...meta, manualPayment: { paymentId: payment.id, verifiedById: user.id, verifiedByName: actorName, at: now.toISOString(), reference: input.reference ?? null } } as unknown as Prisma.InputJsonValue } });
    await tx.activity.create({
      data: {
        leadId: order.leadId, orderId, actorId: user.id, actorRole: user.role, source: ActivitySource.USER, type: ActivityType.PAYMENT_STATUS_CHANGED, referenceType: "Payment", referenceId: payment.id,
        title: `Payment manually marked as paid by ${actorName} (verified outside Cashfree)`,
        description: `Unpaid -> SUCCESS. Reason: ${input.reason}${input.reference ? `. Reference: ${input.reference}` : ""}`,
        oldValue: { orderStatus: order.status, payments: previous } as unknown as Prisma.InputJsonValue,
        newValue: { paymentStatus: "SUCCESS", amount: order.totalAmount.toString(), verification: "MANUAL_EXTERNAL" } as unknown as Prisma.InputJsonValue,
        metadata: { verification: "MANUAL_EXTERNAL", reason: input.reason, reference: input.reference ?? null, cashfreeVerified: false } as unknown as Prisma.InputJsonValue,
        createdAt: now,
      },
    });
    // The person who verified the payment is the order's confirmer ("CRM Confirmed by <their name>"), from the authenticated user - never from the request.
    await recordConfirmation(tx, orderId, { id: user.id, role: user.role }, now).catch(() => undefined);
    return { order, alreadyPaid: false as const, payment: { id: payment.id, verification: "MANUAL_EXTERNAL" as const, amount: order.totalAmount.toString(), paidAt: now.toISOString() }, openCashfreeLink };
  });

  // Same follow-up as a verified payment: confirm the order, create/link the Shopify order and mark it paid there. Never throws; Shopify problems are recorded on the order and returned below.
  await confirmAndSyncPaidOrder({ runner, getShopifyClient: deps.getShopifyClient }, orderId, { source: ActivitySource.USER, actor: { id: user.id, role: user.role } }, () => now);

  const fresh = await runner.$transaction((tx: Db) => tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, externalId: true, metadata: true } }));
  const fm = asRecord(fresh.metadata);
  const sync = asRecord(fm.shopifyPaymentSync);
  const create = asRecord(fm.shopifySync);
  const paymentSync = sync.status === "synced" ? "synced" : sync.status === "failed" ? "failed" : "pending";
  const reason = paymentSync === "failed" ? safeMessage(sync.reason, "Shopify did not record the payment.") : !fresh.externalId && create.status === "failed" ? safeMessage(create.error, "Shopify did not accept the order.") : undefined;
  return {
    orderId,
    orderNumber: recorded.order.orderNumber,
    alreadyPaid: recorded.alreadyPaid,
    orderStatus: fresh.status,
    payment: recorded.payment,
    shopify: { linked: Boolean(fresh.externalId), paymentSync, ...(reason ? { reason } : {}) },
    openCashfreeLink: recorded.openCashfreeLink,
  };
}

/** POST /orders/:id/mark-paid  { reason, reference? } - roles ADMIN / MANAGER / SALESPERSON (route + service), within the caller's order scope. */
export const markOrderPaid = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orderId = String(req.params.id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) throw new ApiError("Invalid order id", STATUS_CODES.BAD_REQUEST);
    const result = await markPrepaidOrderPaid(prisma as never, req.user!, orderId, req.body);
    sendResponse(res, true, result, result.alreadyPaid ? "This order was already paid." : "Payment recorded.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
