import { createHash } from "node:crypto";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { OrderStatus, PaymentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { advisoryLock, asRecord, safeMessage, toTenDigitMobile, type TxRunner } from "../integrations/integrations.common.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { orderLockKey } from "./cashfree.apply.js";
import type { CashfreeOrder, CashfreeOrderPayment, CreateOrderRequest } from "./cashfree.client.js";
import { upiQrBlockReason, type CashfreeConfig } from "./cashfree.config.js";
import { assertDirectUpiQr } from "./cashfree.upi-qr-decode.js";

// ORDER-SPECIFIC UPI QR (Cashfree PG "Order Pay", payment_method.upi.channel = "qrcode"): a QR that encodes the UPI payment request itself, so the customer's UPI app shows the exact amount.
// (The QR of a Payment Link only opens the Cashfree page in a browser - see whatsapp.payment-qr.ts, which stays as the fallback.)
//
//  - One CRM Payment <-> one Cashfree order <-> one QR. The Cashfree order_id is derived from the CRM payment id (qr_<id>) and every request carries an idempotency key derived from it, so a retry,
//    a double click or two servers can never create a second order for the same payment; a stored QR is simply returned again. It is never shared with another payment or order.
//  - It is only created for an OPEN Cashfree payment of a live order, in INR, for the payment's exact amount; the order Cashfree answers with is checked against that amount and currency before Order Pay is called.
//  - The PNG (not a secret: it is what the customer receives) is kept on the payment row (metadata.upiQr). The payment session id and the credentials are never stored or returned.
//  - Creating or sending a QR NEVER marks anything paid. Payment is confirmed only by verifyQrOrderPaid (Cashfree's own answer), through the same reconciliation as a payment link.
//  - Needs the S2S flag enabled on the Cashfree account ("To use this API S2S flag needs to be enabled from the backend"); without it Cashfree refuses and the caller falls back to the link QR.

export interface UpiQrApi {
  createOrder(request: CreateOrderRequest, idempotencyKey: string): Promise<CashfreeOrder>;
  getOrder(orderId: string): Promise<CashfreeOrder>;
  payUpiQr(paymentSessionId: string, idempotencyKey: string): Promise<{ png: Buffer; cfPaymentId: string | null; paymentAmount: string | null }>;
  getOrderPayments?(orderId: string): Promise<CashfreeOrderPayment[]>;
  /** Terminate Order (PATCH /orders/{id}, order_status TERMINATED) - see CashfreeClient.terminateOrder. */
  terminateOrder?(orderId: string, idempotencyKey: string): Promise<CashfreeOrder>;
}

export interface StoredUpiQr {
  orderId: string;
  cfOrderId: string | null;
  amount: string;
  currency: string;
  png: Buffer;
  createdAt: string;
}

export interface UpiQrDeps {
  runner: TxRunner;
  api: UpiQrApi;
  config: CashfreeConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

const OPEN = new Set<PaymentStatus>([PaymentStatus.PENDING, PaymentStatus.PROCESSING]);
const BLOCKED = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.RETURNED]);
const MIN_ORDER_LIFETIME_MS = 30 * 60_000;

/** Cashfree's order_id for this payment's QR: stable, unique per payment, 35 characters. */
export const qrOrderIdFor = (paymentId: string) => `qr_${paymentId.replace(/-/g, "")}`;

/** A UUID derived from the payment id and a purpose, so the same request always carries the same idempotency key. */
export function idempotencyKeyFor(purpose: "create" | "pay" | "terminate", paymentId: string): string {
  const h = createHash("sha256").update(`crm-upi-qr:${purpose}:${paymentId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const formatExpiry = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** The QR stored on a payment, or null. The stored bytes are re-checked, so a damaged value is never served. */
export function readStoredUpiQr(metadata: unknown): StoredUpiQr | null {
  const q = asRecord(asRecord(metadata).upiQr);
  if (q.directUpi !== true || typeof q.orderId !== "string" || typeof q.png !== "string" || typeof q.amount !== "string" || typeof q.currency !== "string") return null;
  const png = Buffer.from(q.png, "base64");
  if (png.length < 200 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return null;
  return { orderId: q.orderId, cfOrderId: typeof q.cfOrderId === "string" ? q.cfOrderId : null, amount: q.amount, currency: q.currency, png, createdAt: typeof q.createdAt === "string" ? q.createdAt : "" };
}

const PAYMENT_SELECT = {
  id: true,
  orderId: true,
  status: true,
  amount: true,
  currency: true,
  externalSource: true,
  paymentExpiresAt: true,
  metadata: true,
  order: { select: { orderNumber: true, status: true, leadId: true, lead: { select: { normalizedMobile: true, firstName: true, lastName: true } } } },
} satisfies Prisma.PaymentSelect;

const fail = (message: string, status: number = STATUS_CODES.BAD_REQUEST) => new ApiError(message, status);

/**
 * The dynamic UPI QR of an open Cashfree payment: the stored one, or - once - a new one. Throws an ApiError with a safe message for anything that must not (or could not) produce a QR;
 * the caller (the WhatsApp sender) then keeps using the payment link. Never changes a payment's status.
 */
export async function ensureUpiQr(deps: UpiQrDeps, paymentId: string): Promise<StoredUpiQr> {
  const now = (deps.now ?? (() => new Date()))();
  const blocked = upiQrBlockReason(deps.config, deps.env ?? process.env);
  if (blocked) throw fail(blocked, STATUS_CODES.FORBIDDEN);

  // 1. Read and validate under the order lock; return the stored QR if there already is one.
  const payment = await deps.runner.$transaction(async (tx) => {
    const head = await tx.payment.findUnique({ where: { id: paymentId }, select: { orderId: true } });
    if (!head) throw fail("Payment not found", STATUS_CODES.NOT_FOUND);
    await advisoryLock(tx, orderLockKey(head.orderId));
    return tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: PAYMENT_SELECT });
  });
  if (payment.externalSource !== "CASHFREE") throw fail("This is not a Cashfree payment.");
  if (!OPEN.has(payment.status)) throw fail(`The payment is already ${payment.status.toLowerCase().replace("_", " ")}, so no UPI QR is created.`);
  if (BLOCKED.has(payment.order.status)) throw fail("The order is no longer payable.");
  if (payment.paymentExpiresAt && payment.paymentExpiresAt <= now) throw fail("The payment has expired. Create a new payment link first.");
  if (payment.currency !== "INR") throw fail("A UPI QR can only collect INR.");
  // a payment that is still open and already has its QR gets that same QR again (never a second order); a closed / cancelled / expired payment never gets one
  const existing = readStoredUpiQr(payment.metadata);
  if (existing && existing.orderId === qrOrderIdFor(paymentId)) return existing;
  const cents = toCents(payment.amount.toString());
  if (cents < 100) throw fail("The payment amount is below the Cashfree minimum of ₹1.");
  const amount = fromCents(cents);
  const phone = toTenDigitMobile(payment.order.lead.normalizedMobile);
  if (!phone) throw fail("The customer has no valid mobile number for the Cashfree order.");

  // 2. Cashfree: the order for exactly this payment (get it if it already exists, else create it), checked against the CRM's amount and currency BEFORE Order Pay.
  const orderId = qrOrderIdFor(paymentId);
  let order: CashfreeOrder | null = null;
  try {
    order = await deps.api.getOrder(orderId);
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
  if (!order) {
    const expiresAt = new Date(Math.max(payment.paymentExpiresAt?.getTime() ?? 0, now.getTime() + MIN_ORDER_LIFETIME_MS));
    order = await deps.api.createOrder(
      {
        order_id: orderId,
        order_amount: Number(amount),
        order_currency: "INR",
        customer_details: { customer_id: `crm${payment.order.leadId.replace(/-/g, "").slice(0, 28)}`, customer_phone: phone },
        ...(deps.config.notifyUrl ? { order_meta: { notify_url: deps.config.notifyUrl } } : {}),
        order_expiry_time: formatExpiry(expiresAt),
        order_note: `Order ${payment.order.orderNumber}`.slice(0, 200),
        order_tags: { crm_payment_id: paymentId, crm_order: payment.order.orderNumber },
      },
      idempotencyKeyFor("create", paymentId),
    );
  }
  if (order.orderId !== orderId) throw fail("Cashfree answered for a different order; no QR was created.", 502);
  if (toCents(order.orderAmount) !== cents || (order.orderCurrency ?? "INR").toUpperCase() !== "INR") throw fail("The Cashfree order does not match the payment's amount and currency; no QR was created.", 502);
  if (order.orderStatus !== "ACTIVE") throw fail(`The Cashfree order is ${order.orderStatus.toLowerCase()}, so no QR was created. Use Refresh on the payment.`, 409);
  if (!order.paymentSessionId) throw fail("Cashfree returned no payment session for the order.", 502);

  // 3. Order Pay -> the QR (idempotent per payment). An answer that is not a usable PNG is an error, never sent on.
  const qr = await deps.api.payUpiQr(order.paymentSessionId, idempotencyKeyFor("pay", paymentId));
  if (qr.paymentAmount && toCents(qr.paymentAmount) !== cents) throw fail("Cashfree's QR is for a different amount; it was discarded.", 502);
  // The picture is only called a direct UPI QR after it is DECODED: a UPI pay request for this exact amount and currency. A QR that opens a web page (checkout / payment link) is refused.
  try {
    assertDirectUpiQr(qr.png, { amount, currency: "INR", payee: (deps.env ?? process.env).CASHFREE_UPI_QR_EXPECTED_PAYEE?.trim() || undefined });
  } catch (error) {
    throw fail(error instanceof Error ? error.message : "Cashfree's QR was not a direct UPI QR.", 502);
  }

  // 4. Store it - unless a concurrent request stored one first, which is then the one every caller gets.
  return deps.runner.$transaction(async (tx) => {
    await advisoryLock(tx, orderLockKey(payment.orderId));
    const fresh = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { metadata: true, status: true } });
    const stored = readStoredUpiQr(fresh.metadata);
    if (stored && stored.orderId === orderId) return stored;
    const record: StoredUpiQr = { orderId, cfOrderId: order!.cfOrderId, amount, currency: "INR", png: qr.png, createdAt: now.toISOString() };
    const meta = asRecord(fresh.metadata);
    await tx.payment.update({
      where: { id: paymentId },
      data: { metadata: { ...meta, upiQr: { directUpi: true, orderId, cfOrderId: record.cfOrderId, cfPaymentId: qr.cfPaymentId, amount, currency: "INR", png: qr.png.toString("base64"), createdAt: record.createdAt } } as Prisma.InputJsonValue },
    });
    return record;
  });
}

export type QrOrderVerdict =
  | { paid: false; status: string; reportedAmount?: string }
  | { paid: true; amount: string; cfOrderId: string | null; cfPaymentId: string | null; bankReference: string | null; paymentGroup: string | null; paidAt: string | null };

/**
 * Asks Cashfree (never the webhook body) whether the QR's order was really paid: the order must be PAID for exactly the CRM payment's amount in INR, and exactly one successful payment must
 * exist on it for that amount. Anything else is "not paid" (and an amount that differs is reported so it can be flagged). A failed lookup throws, so the caller retries instead of guessing.
 */
export async function verifyQrOrderPaid(api: Pick<UpiQrApi, "getOrder" | "getOrderPayments">, orderId: string, expected: { amount: string; currency: string }): Promise<QrOrderVerdict> {
  const order = await api.getOrder(orderId);
  if (order.orderId !== orderId) return { paid: false, status: "ORDER_MISMATCH" };
  if (order.orderStatus !== "PAID") return { paid: false, status: order.orderStatus };
  if ((order.orderCurrency ?? "INR").toUpperCase() !== expected.currency.toUpperCase()) return { paid: false, status: "CURRENCY_MISMATCH" };
  if (toCents(order.orderAmount) !== toCents(expected.amount)) return { paid: false, status: "AMOUNT_MISMATCH", reportedAmount: order.orderAmount ?? undefined };
  if (!api.getOrderPayments) return { paid: false, status: "NO_PAYMENT_LOOKUP" };
  const successful = (await api.getOrderPayments(orderId)).filter((p) => p.paymentStatus === "SUCCESS");
  const distinct = [...new Map(successful.map((p) => [p.cfPaymentId, p])).values()];
  if (distinct.length !== 1) return { paid: false, status: distinct.length === 0 ? "NO_SUCCESSFUL_PAYMENT" : "AMBIGUOUS_PAYMENTS" };
  const p = distinct[0]!;
  if (toCents(p.paymentAmount) !== toCents(expected.amount)) return { paid: false, status: "AMOUNT_MISMATCH", reportedAmount: p.paymentAmount ?? undefined };
  return { paid: true, amount: fromCents(toCents(p.paymentAmount)), cfOrderId: order.cfOrderId, cfPaymentId: p.cfPaymentId, bankReference: p.bankReference, paymentGroup: p.paymentGroup, paidAt: p.paymentTime };
}

/** Credential-looking text (Meta tokens, bearer / secret / token words and the value after them) is removed before a provider error is stored. */
const redactSecrets = (text: string) => text.replace(/EAA[A-Za-z0-9]{8,}/g, "[redacted]").replace(/(authorization|bearer|access[_ -]?token|token|secret|password)\s*[:=]?\s*\S+/gi, "[redacted]");

export interface CloseOpenMethodsDeps {
  runner: TxRunner;
  api: { terminateOrder?: (orderId: string, idempotencyKey: string) => Promise<CashfreeOrder>; cancelLink?: (linkId: string) => Promise<unknown> };
  now?: () => Date;
}

/**
 * Closes what is still payable for a CRM payment once it has settled or failed, so the customer cannot also pay the other way:
 *  - the payment FAILED (link cancelled / expired, order cancelled) or was paid THROUGH THE LINK -> terminate the UPI QR's Cashfree order (Terminate Order);
 *  - the payment was paid THROUGH THE QR -> cancel the payment link.
 * Only acts when a UPI QR was ever created for the payment (so with the feature unused no Cashfree request is made). Best effort and recorded on the payment (metadata.upiQr.closed): Cashfree may refuse or
 * only "request" termination while a transaction is in flight, and a payment that still arrives is caught by applyPaymentUpdate as a duplicate / late payment - never applied twice, never lost.
 */
export async function closeOpenMethods(deps: CloseOpenMethodsDeps, paymentId: string, to: "SUCCESS" | "FAILED", via: string | null): Promise<"nothing" | "closed" | "failed"> {
  const now = (deps.now ?? (() => new Date()))();
  const payment = await deps.runner.$transaction((tx) => tx.payment.findUnique({ where: { id: paymentId }, select: { externalSource: true, externalId: true, metadata: true } }));
  if (!payment || payment.externalSource !== "CASHFREE") return "nothing";
  const qr = asRecord(asRecord(payment.metadata).upiQr);
  const qrOrderId = typeof qr.orderId === "string" ? qr.orderId : null;
  if (!qrOrderId) return "nothing";
  const paidByQr = to === "SUCCESS" && via === "upi_qr";
  if (!paidByQr && qr.closed && asRecord(qr.closed).ok === true) return "nothing";

  const record = (closed: Record<string, unknown>) =>
    deps.runner.$transaction(async (tx) => {
      const head = await tx.payment.findUnique({ where: { id: paymentId }, select: { orderId: true } });
      if (!head) return;
      await advisoryLock(tx, orderLockKey(head.orderId));
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { metadata: true } });
      const meta = asRecord(fresh.metadata);
      await tx.payment.update({ where: { id: paymentId }, data: { metadata: { ...meta, upiQr: { ...asRecord(meta.upiQr), closed: { ...closed, at: now.toISOString() } } } as Prisma.InputJsonValue } });
    });

  try {
    if (paidByQr) {
      if (!deps.api.cancelLink || !payment.externalId) return "nothing";
      await deps.api.cancelLink(payment.externalId);
      await record({ action: "cancel_link", ok: true });
    } else {
      if (!deps.api.terminateOrder) return "nothing";
      const answer = await deps.api.terminateOrder(qrOrderId, idempotencyKeyFor("terminate", paymentId));
      await record({ action: "terminate_qr_order", ok: true, status: answer.orderStatus });
    }
    return "closed";
  } catch (error) {
    await record({ action: paidByQr ? "cancel_link" : "terminate_qr_order", ok: false, error: safeMessage(redactSecrets(error instanceof Error ? error.message : String(error))) });
    return "failed";
  }
}
