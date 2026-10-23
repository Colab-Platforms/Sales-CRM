import { randomUUID } from "node:crypto";
import { asRecord, asString, requestJson } from "../integrations/integrations.common.js";
import type { CashfreeConfig } from "./cashfree.config.js";

// The only place that talks to Cashfree. Documented contract (Cashfree PG API reference, Payment Links):
//   POST /links                      create a link            -> link_url, link_status, cf_link_id
//   GET  /links/{link_id}            fetch link details       -> link_status, link_amount_paid   (path per Cashfree's link APIs; confirm in sandbox)
//   POST /links/{link_id}/cancel     cancel an unpaid link    (path per Cashfree's link APIs; confirm in sandbox)
// Auth: x-client-id + x-client-secret, plus x-api-version. Create accepts x-idempotency-key (UUID) for safe retries.

export interface CreateLinkRequest {
  link_id: string;
  link_amount: number;
  link_currency: string;
  link_purpose: string;
  customer_details: { customer_phone: string; customer_name?: string; customer_email?: string };
  /** The link must be paid in one go for its exact amount. */
  link_partial_payments: false;
  link_expiry_time: string;
  /** The CRM sends the link itself (WhatsApp); Cashfree must not message the customer separately. */
  link_notify: { send_sms: false; send_email: false };
  link_auto_reminders: false;
  link_meta?: { notify_url?: string; return_url?: string };
  link_notes: Record<string, string>;
}

export interface CashfreeLink {
  cfLinkId: string | null;
  linkId: string;
  /** ACTIVE | PAID | PARTIALLY_PAID | EXPIRED | CANCELLED (as reported; unknown values are kept as text). */
  linkStatus: string;
  linkUrl: string | null;
  linkAmount: string | null;
  linkAmountPaid: string | null;
  linkExpiryTime: string | null;
}

export function parseLink(json: unknown): CashfreeLink | null {
  const body = asRecord(json);
  const linkId = asString(body.link_id);
  const linkStatus = asString(body.link_status);
  if (!linkId || !linkStatus) return null;
  return {
    cfLinkId: asString(body.cf_link_id),
    linkId,
    linkStatus: linkStatus.toUpperCase(),
    linkUrl: asString(body.link_url),
    linkAmount: asString(body.link_amount),
    linkAmountPaid: asString(body.link_amount_paid),
    linkExpiryTime: asString(body.link_expiry_time),
  };
}

/** One order Cashfree created behind a payment link (read-only lookup: GET /links/{link_id}/orders). `orderId` is Cashfree's order_id, NOT the CRM link id. */
export interface CashfreeLinkOrder {
  orderId: string;
  cfOrderId: string | null;
  linkId: string | null;
  orderStatus: string;
  orderAmount: string | null;
}

export function parseLinkOrders(json: unknown): CashfreeLinkOrder[] | null {
  if (!Array.isArray(json)) return null;
  const orders: CashfreeLinkOrder[] = [];
  for (const raw of json) {
    const o = asRecord(raw);
    const orderId = asString(o.order_id);
    const orderStatus = asString(o.order_status);
    if (!orderId || !orderStatus) continue;
    orders.push({ orderId, cfOrderId: asString(o.cf_order_id), linkId: asString(o.link_id), orderStatus: orderStatus.toUpperCase(), orderAmount: asString(o.order_amount) });
  }
  return orders;
}

/** One payment attempt on a Cashfree order (read-only lookup: GET /orders/{order_id}/payments). `cfPaymentId` is the payment's own id (cf_payment_id). */
export interface CashfreeOrderPayment {
  cfPaymentId: string;
  paymentStatus: string;
  paymentAmount: string | null;
  bankReference: string | null;
  paymentGroup: string | null;
  paymentTime: string | null;
}

export function parseOrderPayments(json: unknown): CashfreeOrderPayment[] | null {
  if (!Array.isArray(json)) return null;
  const payments: CashfreeOrderPayment[] = [];
  for (const raw of json) {
    const p = asRecord(raw);
    const cfPaymentId = asString(p.cf_payment_id);
    const paymentStatus = asString(p.payment_status);
    if (!cfPaymentId || !paymentStatus) continue;
    payments.push({ cfPaymentId, paymentStatus: paymentStatus.toUpperCase(), paymentAmount: asString(p.payment_amount), bankReference: asString(p.bank_reference), paymentGroup: asString(p.payment_group), paymentTime: asString(p.payment_time) });
  }
  return payments;
}

/** Body of POST /orders/{order_id}/refunds. refund_id is 3-40 alphanumeric characters; refund_note 3-100 characters. */
export interface CreateRefundRequest {
  refund_amount: number;
  refund_id: string;
  refund_note: string;
  refund_speed: "STANDARD";
}

/** A refund as Cashfree reports it (create answer or status lookup). `refundStatus` is Cashfree's own text (SUCCESS, PENDING, PENDING_APPROVAL, CANCELLED, ONHOLD, REJECTED). */
export interface CashfreeRefund {
  cfRefundId: string | null;
  refundId: string;
  orderId: string | null;
  refundStatus: string;
  refundAmount: string | null;
  refundCurrency: string | null;
  statusDescription: string | null;
  refundArn: string | null;
  processedAt: string | null;
}

export function parseRefund(json: unknown): CashfreeRefund | null {
  const r = asRecord(json);
  const refundId = asString(r.refund_id);
  const refundStatus = asString(r.refund_status);
  if (!refundId || !refundStatus) return null;
  return {
    cfRefundId: asString(r.cf_refund_id),
    refundId,
    orderId: asString(r.order_id),
    refundStatus: refundStatus.toUpperCase(),
    refundAmount: asString(r.refund_amount),
    refundCurrency: asString(r.refund_currency),
    statusDescription: asString(r.status_description),
    refundArn: asString(r.refund_arn),
    processedAt: asString(r.processed_at),
  };
}

/** Body of POST /orders (Create Order). order_id is 3-45 characters of letters, digits, _ and -. Amounts carry at most two decimals. */
export interface CreateOrderRequest {
  order_id: string;
  order_amount: number;
  order_currency: string;
  customer_details: { customer_id: string; customer_phone: string; customer_name?: string };
  order_meta?: { notify_url?: string; return_url?: string };
  order_expiry_time?: string;
  order_note?: string;
  order_tags?: Record<string, string>;
}

/** A Cashfree PG order (Create Order / Get Order). paymentSessionId is what Order Pay needs; it is never stored or sent to the frontend. */
export interface CashfreeOrder {
  cfOrderId: string | null;
  orderId: string;
  /** ACTIVE | PAID | EXPIRED | TERMINATION_REQUESTED | TERMINATED (as reported). */
  orderStatus: string;
  paymentSessionId: string | null;
  orderAmount: string | null;
  orderCurrency: string | null;
  orderExpiryTime: string | null;
}

export function parseOrder(json: unknown): CashfreeOrder | null {
  const o = asRecord(json);
  const orderId = asString(o.order_id);
  const orderStatus = asString(o.order_status);
  if (!orderId || !orderStatus) return null;
  return { cfOrderId: asString(o.cf_order_id), orderId, orderStatus: orderStatus.toUpperCase(), paymentSessionId: asString(o.payment_session_id), orderAmount: asString(o.order_amount), orderCurrency: asString(o.order_currency), orderExpiryTime: asString(o.order_expiry_time) };
}

/** Body of POST /orders/sessions (Order Pay) for a UPI QR. */
export interface PayUpiQrRequest {
  payment_session_id: string;
  payment_method: { upi: { channel: "qrcode" } };
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_QR_BYTES = 256 * 1024;
const MIN_QR_BYTES = 200;

const PNG_DATA_URI = /^data:image\/png;base64,/i;

/**
 * The QR image of an Order Pay answer for channel "qrcode".
 * The shape supported is the one Cashfree SUPPORT supplied - NOT part of Cashfree's published reference, and not yet confirmed against a real answer:
 *   { action: "custom", payment_method: "upi", channel: "qrcode", payment_amount, data: { payload: { qrcode: "data:image/png;base64,..." } } }
 * Fails closed (null) on anything else: a missing / non-string data.payload.qrcode; a value that is not a PNG data URI (a bare base64 string, another image type, a URL); an action other than "custom"
 * (a "link" / "post" / "form" answer is a redirect to a checkout page); a payment_method other than upi; a channel other than qrcode; text that is not base64; bytes that are not a PNG of a sane size.
 * data.payload.default, data.url and every other field are NEVER read as the QR - a UPI string is not assumed to be there. Whether the picture really is a direct UPI request for the right amount is
 * checked separately by DECODING it (cashfree.upi-qr-decode.ts); this function only extracts the image.
 */
export function parseUpiQrPay(json: unknown): { png: Buffer; cfPaymentId: string | null; paymentAmount: string | null } | null {
  const body = asRecord(json);
  const channel = asString(body.channel);
  if (channel && channel.toLowerCase() !== "qrcode") return null;
  const action = asString(body.action);
  if (action && action.toLowerCase() !== "custom") return null;
  const method = asString(body.payment_method);
  if (method && method.toLowerCase() !== "upi") return null;
  const raw = asRecord(asRecord(body.data).payload).qrcode;
  if (typeof raw !== "string" || !PNG_DATA_URI.test(raw.trim())) return null;
  const text = raw.trim().replace(PNG_DATA_URI, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  const png = Buffer.from(text, "base64");
  if (png.length < MIN_QR_BYTES || png.length > MAX_QR_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { png, cfPaymentId: asString(body.cf_payment_id), paymentAmount: asString(body.payment_amount) };
}

export class CashfreeClient {
  constructor(
    private readonly config: CashfreeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "x-client-id": this.config.clientId,
      "x-client-secret": this.config.clientSecret,
      "x-api-version": this.config.apiVersion,
      "x-request-id": randomUUID(),
      ...extra,
    };
  }

  private async call(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<unknown> {
    const { json } = await requestJson({
      provider: "CASHFREE",
      fetchImpl: this.fetchImpl,
      url: `${this.config.baseUrl}${path}`,
      method,
      headers: this.headers(extraHeaders),
      body,
    });
    return json;
  }

  async createLink(request: CreateLinkRequest, idempotencyKey: string): Promise<CashfreeLink> {
    const link = parseLink(await this.call("POST", "/links", request, { "x-idempotency-key": idempotencyKey }));
    if (!link || !link.linkUrl) throw new Error("Cashfree answered without a payment link");
    return link;
  }

  async getLink(linkId: string): Promise<CashfreeLink> {
    const link = parseLink(await this.call("GET", `/links/${encodeURIComponent(linkId)}`));
    if (!link) throw new Error("Cashfree answered without link details");
    return link;
  }

  /** The orders Cashfree created behind a link (status=ALL: this sandbox rejects status=PAID with HTTP 400; callers filter PAID themselves). Read-only (GET). */
  async getLinkOrders(linkId: string): Promise<CashfreeLinkOrder[]> {
    const orders = parseLinkOrders(await this.call("GET", `/links/${encodeURIComponent(linkId)}/orders?status=ALL`));
    if (!orders) throw new Error("Cashfree answered without a list of orders for the link");
    return orders;
  }

  /** The payment attempts on one Cashfree order. Read-only (GET). */
  async getOrderPayments(cashfreeOrderId: string): Promise<CashfreeOrderPayment[]> {
    const payments = parseOrderPayments(await this.call("GET", `/orders/${encodeURIComponent(cashfreeOrderId)}/payments`));
    if (!payments) throw new Error("Cashfree answered without a list of payments for the order");
    return payments;
  }

  /**
   * Create Refund: POST /orders/{order_id}/refunds. `cashfreeOrderId` is Cashfree's order_id (metadata.cashfree.cashfreeOrderId), never the CRM link id
   * or a payment id. The idempotency key (a UUID) makes a repeat of the SAME request safe; the refund_id is also unique per refund at Cashfree.
   */
  async createRefund(cashfreeOrderId: string, request: CreateRefundRequest, idempotencyKey: string): Promise<CashfreeRefund> {
    const refund = parseRefund(await this.call("POST", `/orders/${encodeURIComponent(cashfreeOrderId)}/refunds`, request, { "x-idempotency-key": idempotencyKey }));
    if (!refund) throw new Error("Cashfree answered without refund details");
    return refund;
  }

  /** Get Refund (read-only): GET /orders/{order_id}/refunds/{refund_id}. */
  async getRefund(cashfreeOrderId: string, refundId: string): Promise<CashfreeRefund> {
    const refund = parseRefund(await this.call("GET", `/orders/${encodeURIComponent(cashfreeOrderId)}/refunds/${encodeURIComponent(refundId)}`));
    if (!refund) throw new Error("Cashfree answered without refund details");
    return refund;
  }

  /** Create Order: POST /orders. The idempotency key (a UUID) makes a retry of the SAME request safe. */
  async createOrder(request: CreateOrderRequest, idempotencyKey: string): Promise<CashfreeOrder> {
    const order = parseOrder(await this.call("POST", "/orders", request, { "x-idempotency-key": idempotencyKey }));
    if (!order || !order.paymentSessionId) throw new Error("Cashfree answered without an order and payment session");
    return order;
  }

  /** Get Order (read-only): GET /orders/{order_id}. */
  async getOrder(orderId: string): Promise<CashfreeOrder> {
    const order = parseOrder(await this.call("GET", `/orders/${encodeURIComponent(orderId)}`));
    if (!order) throw new Error("Cashfree answered without order details");
    return order;
  }

  /** Order Pay for a UPI QR: POST /orders/sessions with payment_method.upi.channel = "qrcode". Needs the S2S flag enabled on the Cashfree account. Fails closed on an unusable answer. */
  async payUpiQr(paymentSessionId: string, idempotencyKey: string): Promise<{ png: Buffer; cfPaymentId: string | null; paymentAmount: string | null }> {
    const request: PayUpiQrRequest = { payment_session_id: paymentSessionId, payment_method: { upi: { channel: "qrcode" } } };
    const qr = parseUpiQrPay(await this.call("POST", "/orders/sessions", request, { "x-idempotency-key": idempotencyKey }));
    if (!qr) throw new Error("Cashfree answered without a usable UPI QR image");
    return qr;
  }

  /**
   * Terminate Order: PATCH /orders/{order_id} with order_status "TERMINATED" (Cashfree PG reference, Orders > Terminate Order). The answer is the order: TERMINATED, or TERMINATION_REQUESTED while
   * Cashfree finishes it. Cashfree warns that an order with a transaction already in flight may not terminate - a payment that still arrives is handled as a late / duplicate payment.
   */
  async terminateOrder(orderId: string, idempotencyKey: string): Promise<CashfreeOrder> {
    const order = parseOrder(await this.call("PATCH", `/orders/${encodeURIComponent(orderId)}`, { order_status: "TERMINATED" }, { "x-idempotency-key": idempotencyKey }));
    if (!order) throw new Error("Cashfree answered without order details");
    return order;
  }

  async cancelLink(linkId: string): Promise<CashfreeLink | null> {
    return parseLink(await this.call("POST", `/links/${encodeURIComponent(linkId)}/cancel`));
  }
}
