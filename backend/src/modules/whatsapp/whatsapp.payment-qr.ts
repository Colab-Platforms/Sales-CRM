import { randomBytes, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { resolvePublicBackendUrl } from "../cashfree/cashfree.config.js";
import { asRecord, safeMessage, type Db } from "../integrations/integrations.common.js";
import WhatsAppFreeTextService from "./whatsapp.freetext.service.js";
import { tryRenderPaymentCardPng } from "./whatsapp.payment-qr.card.js";
import { ActivitySource, ActivityType } from "../../../generated/prisma/enums.js";

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

/** The name on the card: PAYMENT_QR_MERCHANT_NAME, else "Ayush Wellness". */
export const paymentCardMerchantName = (env: NodeJS.ProcessEnv = process.env): string => (env.PAYMENT_QR_MERCHANT_NAME ?? "").trim().slice(0, 60) || "Ayush Wellness";

/**
 * The image that is sent and shown: the branded card (merchant, order, exact amount, the QR of the stored payment URL, instructions). If the card cannot be drawn the plain QR of the SAME URL is used,
 * so a drawing problem never blocks or changes the payment request.
 */
export async function buildPaymentQrImage(payment: { paymentUrl: string | null; currency: string; amount: { toString(): string } }, orderNumber: string): Promise<Buffer> {
  if (!isCashfreePaymentUrl(payment.paymentUrl)) throw new Error("This payment has no Cashfree payment link to turn into a QR code");
  const card = await tryRenderPaymentCardPng({ paymentUrl: payment.paymentUrl!, orderNumber, currency: payment.currency, amount: payment.amount.toString(), merchantName: paymentCardMerchantName() });
  return card ?? renderPaymentQrPng(payment.paymentUrl!);
}

export const QR_MEDIA_NAME = (orderNumber: string): string => `payment-qr-${orderNumber}.png`;
export const PAYMENT_QR_ACTIVITY_KEY = "paymentQrImage";
const QR_CAPTION_START = /^Scan to pay /;

/**
 * Which outbound WhatsApp messages are payment QR images, and for which payment - so the CRM can SHOW them. New messages carry an activity row written at send time (exact); messages sent before that
 * existed are recognised by their caption on an order and matched to the Cashfree payment that existed when they were sent. Read-only.
 */
export async function resolvePaymentQrMessages(db: Db, messageIds: string[]): Promise<Map<string, { paymentId: string; orderNumber: string }>> {
  const out = new Map<string, { paymentId: string; orderNumber: string }>();
  if (messageIds.length === 0) return out;
  const acts = await db.activity.findMany({ where: { type: ActivityType.WHATSAPP_MESSAGE_SENT, referenceType: "WhatsAppMessage", referenceId: { in: messageIds } }, select: { referenceId: true, metadata: true } });
  const exact = new Map<string, string>();
  for (const a of acts) {
    const id = asRecord(asRecord(a.metadata)[PAYMENT_QR_ACTIVITY_KEY]).paymentId;
    if (a.referenceId && typeof id === "string") exact.set(a.referenceId, id);
  }
  const rows = await db.whatsAppMessage.findMany({ where: { id: { in: messageIds }, direction: "OUTBOUND", messageType: "MEDIA", orderId: { not: null } }, select: { id: true, orderId: true, body: true, createdAt: true } });
  for (const row of rows) {
    const known = exact.get(row.id);
    if (!known && !QR_CAPTION_START.test(row.body ?? "")) continue;
    const payments = await db.payment.findMany({ where: { orderId: row.orderId!, externalSource: "CASHFREE", ...(known ? { id: known } : { createdAt: { lte: new Date(row.createdAt.getTime() + 60_000) } }) }, orderBy: { createdAt: "desc" }, take: 1, select: { id: true, order: { select: { orderNumber: true } } } });
    if (payments[0]) out.set(row.id, { paymentId: payments[0].id, orderNumber: payments[0].order.orderNumber });
  }
  return out;
}

/** The image of a payment's QR for a person to LOOK at (the CRM conversation / order page). Read-only: it never touches a payment, and works for any status (it is what was sent). Null when there is no Cashfree link. */
export async function renderStoredPaymentQr(db: Db, paymentId: string, orderId?: string): Promise<{ png: Buffer; orderNumber: string } | null> {
  const payment = await db.payment.findFirst({ where: { id: paymentId, ...(orderId ? { orderId } : {}) }, select: { externalSource: true, paymentUrl: true, currency: true, amount: true, order: { select: { orderNumber: true } } } });
  if (!payment || payment.externalSource !== "CASHFREE" || !isCashfreePaymentUrl(payment.paymentUrl)) return null;
  return { png: await buildPaymentQrImage({ paymentUrl: payment.paymentUrl, currency: payment.currency, amount: payment.amount }, payment.order.orderNumber), orderNumber: payment.order.orderNumber };
}

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
  if (payment.externalSource !== "CASHFREE" || !isCashfreePaymentUrl(payment.paymentUrl)) return outcome("NOT_SENT", "This payment has no Cashfree payment link or UPI QR to send.");
  if (!OPEN_STATUSES.has(payment.status)) return outcome("NOT_SENT", `The payment is already ${payment.status.toLowerCase().replace("_", " ")}, so no QR code is sent.`);
  if (payment.paymentExpiresAt && payment.paymentExpiresAt <= now) return outcome("NOT_SENT", "The payment link has expired. Create a new payment link first.");
  const previous = asRecord(meta.paymentQr);
  if (!opts.force && previous.status === "SENT" && previous.paymentId === paymentId) return previous as unknown as PaymentQrResult;
  const to = payment.order.lead.normalizedMobile;
  if (!to) return outcome("NOT_SENT", "The customer has no WhatsApp number.");

  const base = deps.publicBaseUrl === undefined ? resolvePublicBackendUrl() : deps.publicBaseUrl;

  try {
    const freeText = deps.freeText ?? new WhatsAppFreeTextService(db);
    const { capability, meta: provider } = await freeText.getCapability(payment.order.leadId);
    if (!capability.freeText.allowed || !provider) return outcome("NOT_SENT", capability.freeText.message ?? "Images can only be sent on Meta inside the 24-hour customer-service window.");

    const caption = qrCaption(payment.order.orderNumber, payment.currency, payment.amount.toString());
    // PREFERRED: upload the PNG to Meta and send it by media id - Meta already holds the file, so it needs no public address of ours and cannot hit a missing / undeployed route (the 131053 "404 downloading
    // media from weblink" failure). FALLBACK (upload refused): the public image URL, when this backend has a public https address.
    let mediaId: string | null = null;
    let uploadError: string | null = null;
    if (typeof provider.uploadMedia === "function") {
      try {
        mediaId = await provider.uploadMedia(await buildPaymentQrImage({ paymentUrl: payment.paymentUrl, currency: payment.currency, amount: payment.amount }, payment.order.orderNumber), "image/png", QR_MEDIA_NAME(payment.order.orderNumber));
      } catch (error) {
        uploadError = redactProviderError(error instanceof Error ? error.message : String(error));
      }
    }
    if (!mediaId && !base) return outcome("NOT_SENT", `The QR image could not be uploaded to WhatsApp${uploadError ? ` (${uploadError})` : ""} and no public https backend address (PUBLIC_BACKEND_URL) is configured as a fallback. The payment link itself is unaffected.`);
    const sent = await provider.sendImage(mediaId ? { to, mediaId, caption } : { to, link: paymentQrImageUrl(base!, paymentId, await ensureQrToken(db, paymentId)), caption });
    const row = await db.whatsAppMessage.create({
      data: { provider: "META", providerMessageId: sent.providerMessageId, direction: "OUTBOUND", messageType: "MEDIA", status: sent.providerMessageId ? "SENT" : "QUEUED", leadId: payment.order.leadId, orderId: payment.orderId, toNumber: to, normalizedContact: to, body: caption, sentById: user.id, sentAt: now },
      select: { id: true },
    });
    // Remember WHICH payment this image belongs to, so the CRM conversation can show the very same QR (no new link is involved).
    await db.activity.create({ data: { leadId: payment.order.leadId, orderId: payment.orderId, actorId: user.id, actorRole: user.role, source: ActivitySource.USER, type: ActivityType.WHATSAPP_MESSAGE_SENT, referenceType: "WhatsAppMessage", referenceId: row.id, title: "Payment QR image sent", description: `QR code for ${payment.order.orderNumber}`, metadata: { [PAYMENT_QR_ACTIVITY_KEY]: { paymentId } } as unknown as Prisma.InputJsonValue, createdAt: now } });
    return outcome("SENT", undefined, row.id);
  } catch (error) {
    return outcome("FAILED", redactProviderError(error instanceof Error ? error.message : String(error)));
  }
}

/** The PNG for the public image URL, or null when the token is wrong or the payment is not (or no longer) an open Cashfree link. */
export async function loadPaymentQrPng(db: Db, paymentId: string, token: string, deps: PaymentQrDeps = {}): Promise<Buffer | null> {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId) || !TOKEN.test(token)) return null;
  const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { status: true, externalSource: true, paymentUrl: true, paymentExpiresAt: true, metadata: true, currency: true, amount: true, order: { select: { orderNumber: true } } } });
  const now = (deps.now ?? (() => new Date()))();
  if (!payment || payment.externalSource !== "CASHFREE" || !OPEN_STATUSES.has(payment.status) || !isCashfreePaymentUrl(payment.paymentUrl)) return null;
  if (payment.paymentExpiresAt && payment.paymentExpiresAt <= now) return null;
  const stored = asRecord(payment.metadata).qrToken;
  if (typeof stored !== "string" || stored.length !== token.length || !timingSafeEqual(Buffer.from(stored), Buffer.from(token))) return null;
  return buildPaymentQrImage({ paymentUrl: payment.paymentUrl, currency: payment.currency, amount: payment.amount }, payment.order.orderNumber);
}
