import { randomBytes, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { resolvePublicBackendUrl } from "../cashfree/cashfree.config.js";
import { asRecord, safeMessage, type Db } from "../integrations/integrations.common.js";
import WhatsAppFreeTextService from "./whatsapp.freetext.service.js";

// A QR code for a PREPAID order's Cashfree payment link, sent to the customer on WhatsApp as an image NEXT TO the payment link message.
//
//  - What the QR encodes: EXACTLY the payment URL Cashfree returned for that payment and the CRM stored (Payment.paymentUrl) - nothing is built, guessed or re-routed. The image is rendered on demand from that stored URL,
//    so it can never drift from the link, and the same order/payment is reused on every retry. (Cashfree's create-link answer may also carry its own QR; this integration does not read it, so the QR is generated here.)
//  - How Meta gets the image: its API takes a public https URL, so the PNG is served by GET /api/public/payment-qr/:paymentId/:token.png on the PUBLIC backend address (PUBLIC_BACKEND_URL, or Render's own
//    RENDER_EXTERNAL_URL). The token is a random value stored on the payment itself (Payment.metadata.qrToken), so ANY backend that shares the database can serve an image another one sent - no shared signing secret is needed,
//    and the image is served only for that payment, only with its token, and only while the payment is still an open Cashfree link.
//  - Safety: sending (or scanning) a QR NEVER changes a payment or order status - payment is confirmed only by the verified Cashfree result (cashfree.reconcile.ts). COD orders never get one.
//  - The QR is a separate message from the link text: its outcome is stored on its own (Order.metadata.paymentQr), so a failed image never hides that the link was sent, and a retry re-sends only the image.

export type PaymentQrStatus = "SENT" | "FAILED" | "NOT_SENT";

export interface PaymentQrResult {
  status: PaymentQrStatus;
  paymentId: string;
  /** Safe, human-readable explanation when status is not SENT (never a credential or a provider response body). */
  reason?: string;
  /** The CRM WhatsApp message row of the image, when one was sent. */
  messageId?: string;
  at: string;
}

export interface PaymentQrDeps {
  freeText?: WhatsAppFreeTextService;
  /** Public https base of this backend (default: PUBLIC_BACKEND_URL / RENDER_EXTERNAL_URL). null = none configured. */
  publicBaseUrl?: string | null;
  now?: () => Date;
}

const OPEN_STATUSES = new Set(["PENDING", "PROCESSING"]);
const TOKEN = /^[0-9a-f]{32}$/;

/** The payment's QR token, created once (atomically - two senders can never end up with different tokens) and stored on the payment row. */
export async function ensureQrToken(db: Db, paymentId: string): Promise<string> {
  const fresh = randomBytes(16).toString("hex");
  await db.$executeRaw`UPDATE payments SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{qrToken}', to_jsonb(${fresh}::text)) WHERE id = ${paymentId}::uuid AND (metadata IS NULL OR metadata->>'qrToken' IS NULL)`;
  const row = await db.payment.findUnique({ where: { id: paymentId }, select: { metadata: true } });
  const token = asRecord(row?.metadata).qrToken;
  if (typeof token !== "string" || !TOKEN.test(token)) throw new Error("The QR token could not be stored");
  return token;
}

export function paymentQrImageUrl(base: string, paymentId: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/api/public/payment-qr/${paymentId}/${token}.png`;
}

/** Only a real Cashfree payment page is ever encoded. */
export const isCashfreePaymentUrl = (value: string | null | undefined): value is string => {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && (url.hostname === "cashfree.com" || url.hostname.endsWith(".cashfree.com"));
  } catch {
    return false;
  }
};

/** The PNG of a QR code that encodes exactly `paymentUrl`. */
export function renderPaymentQrPng(paymentUrl: string): Promise<Buffer> {
  return QRCode.toBuffer(paymentUrl, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 512 });
}

/** A provider error shown to a person: credential-looking text (Meta access tokens, bearer/secret/token words and the value after them) is removed first. */
export const redactProviderError = (text: string): string => safeMessage(text.replace(/EAA[A-Za-z0-9]{8,}/g, "[redacted]").replace(/(authorization|bearer|access[_ -]?token|token|secret|password)\s*[:=]?\s*\S+/gi, "[redacted]"), "The QR image could not be sent.");

const money = (currency: string, amount: string) => `${currency === "INR" ? "₹" : `${currency} `}${Number(amount).toFixed(2)}`;
export const qrCaption = (orderNumber: string, currency: string, amount: string) =>
  `Scan to pay ${money(currency, amount)} for order ${orderNumber}. You can also use the payment link above.`;

export async function recordPaymentQr(db: Db, orderId: string, result: PaymentQrResult): Promise<void> {
  const fresh = await db.order.findUnique({ where: { id: orderId }, select: { metadata: true } });
  const meta = asRecord(fresh?.metadata);
  await db.order.update({ where: { id: orderId }, data: { metadata: { ...meta, paymentQr: result } as unknown as Prisma.InputJsonValue } });
}

/**
 * Sends the QR image of an open Cashfree payment link on WhatsApp. NEVER throws for a delivery problem - the outcome is returned and stored; it only throws ApiError for a request that cannot belong
 * to this order (404). Without `force` an image already SENT for the same payment is not sent again (so a repeated order submission or a retry of the link text cannot double-send it).
 */
export async function sendPaymentQr(db: Db, user: AuthUser, paymentId: string, deps: PaymentQrDeps = {}, opts: { force?: boolean; orderId?: string } = {}): Promise<PaymentQrResult> {
  const now = (deps.now ?? (() => new Date()))();
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, orderId: true, status: true, amount: true, currency: true, externalSource: true, paymentUrl: true, paymentExpiresAt: true, order: { select: { orderNumber: true, metadata: true, leadId: true, lead: { select: { normalizedMobile: true } } } } },
  });
  if (!payment || (opts.orderId && payment.orderId !== opts.orderId)) throw new ApiError("Payment not found", STATUS_CODES.NOT_FOUND);

  const outcome = async (status: PaymentQrStatus, reason?: string, messageId?: string): Promise<PaymentQrResult> => {
    const result: PaymentQrResult = { status, paymentId, ...(reason ? { reason } : {}), ...(messageId ? { messageId } : {}), at: now.toISOString() };
    await recordPaymentQr(db, payment.orderId, result);
    return result;
  };

  const meta = asRecord(payment.order.metadata);
  if (meta.paymentMode !== "PREPAID") return outcome("NOT_SENT", "A QR code is only for prepaid orders (Cash on Delivery has no payment link).");
  if (payment.externalSource !== "CASHFREE" || !isCashfreePaymentUrl(payment.paymentUrl)) return outcome("NOT_SENT", "This payment has no Cashfree payment link to turn into a QR code.");
  if (!OPEN_STATUSES.has(payment.status)) return outcome("NOT_SENT", `The payment is already ${payment.status.toLowerCase().replace("_", " ")}, so no QR code is sent.`);
  if (payment.paymentExpiresAt && payment.paymentExpiresAt <= now) return outcome("NOT_SENT", "The payment link has expired. Create a new payment link first.");
  const previous = asRecord(meta.paymentQr);
  if (!opts.force && previous.status === "SENT" && previous.paymentId === paymentId) return previous as unknown as PaymentQrResult;
  const to = payment.order.lead.normalizedMobile;
  if (!to) return outcome("NOT_SENT", "The customer has no WhatsApp number.");

  const base = deps.publicBaseUrl === undefined ? resolvePublicBackendUrl() : deps.publicBaseUrl;
  if (!base) return outcome("NOT_SENT", "The QR image needs a public https backend address (PUBLIC_BACKEND_URL) so WhatsApp can fetch it. The payment link itself is unaffected.");

  try {
    const freeText = deps.freeText ?? new WhatsAppFreeTextService(db);
    const { capability, meta: provider } = await freeText.getCapability(payment.order.leadId);
    if (!capability.freeText.allowed || !provider) return outcome("NOT_SENT", capability.freeText.message ?? "Images can only be sent on Meta inside the 24-hour customer-service window.");

    const caption = qrCaption(payment.order.orderNumber, payment.currency, payment.amount.toString());
    const sent = await provider.sendImage({ to, link: paymentQrImageUrl(base, paymentId, await ensureQrToken(db, paymentId)), caption });
    const row = await db.whatsAppMessage.create({
      data: { provider: "META", providerMessageId: sent.providerMessageId, direction: "OUTBOUND", messageType: "MEDIA", status: sent.providerMessageId ? "SENT" : "QUEUED", leadId: payment.order.leadId, orderId: payment.orderId, toNumber: to, normalizedContact: to, body: caption, sentById: user.id, sentAt: now },
      select: { id: true },
    });
    return outcome("SENT", undefined, row.id);
  } catch (error) {
    return outcome("FAILED", redactProviderError(error instanceof Error ? error.message : String(error)));
  }
}

/** The PNG for the public image URL, or null when the token is wrong or the payment is not (or no longer) an open Cashfree link. */
export async function loadPaymentQrPng(db: Db, paymentId: string, token: string, deps: PaymentQrDeps = {}): Promise<Buffer | null> {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId) || !TOKEN.test(token)) return null;
  const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { status: true, externalSource: true, paymentUrl: true, paymentExpiresAt: true, metadata: true } });
  const now = (deps.now ?? (() => new Date()))();
  if (!payment || payment.externalSource !== "CASHFREE" || !OPEN_STATUSES.has(payment.status) || !isCashfreePaymentUrl(payment.paymentUrl)) return null;
  if (payment.paymentExpiresAt && payment.paymentExpiresAt <= now) return null;
  const stored = asRecord(payment.metadata).qrToken;
  if (typeof stored !== "string" || stored.length !== token.length || !timingSafeEqual(Buffer.from(stored), Buffer.from(token))) return null;
  return renderPaymentQrPng(payment.paymentUrl);
}
