import { PaymentMethod } from "../../../generated/prisma/enums.js";
import { asRecord, asString, headerOf, sha256Hex } from "../integrations/integrations.common.js";

// Turns a Cashfree webhook body into a small, provider-neutral description of what happened. This is the one place
// that knows Cashfree's payload shapes, so calibrating against real sandbox deliveries means editing only this file.
//
// From Cashfree's documentation:
//   PAYMENT_SUCCESS_WEBHOOK | PAYMENT_FAILED_WEBHOOK | PAYMENT_USER_DROPPED_WEBHOOK | PAYMENT_CHARGES_WEBHOOK
//     { type, event_time, data: { order: {order_id, order_amount, ...}, payment: {cf_payment_id, payment_status,
//       payment_amount, payment_time, bank_reference, payment_group, payment_message}, customer_details } }
//   PAYMENT_LINK_EVENT: link_id, link_status (PAID | PARTIALLY_PAID | EXPIRED | CANCELLED), link_amount, link_amount_paid,
//     and an order object with order_id / transaction details. The page does not say whether these are nested under
//     `data`, so both the flat and the nested form are read.
// UNCONFIRMED until sandbox: whether a payment made through a link also fires PAYMENT_SUCCESS_WEBHOOK, and how its
// order_id relates to the link_id. Both webhook types are therefore matched to the CRM payment by either id.

export const SUPPORTED_TYPES = ["PAYMENT_LINK_EVENT", "PAYMENT_SUCCESS_WEBHOOK", "PAYMENT_FAILED_WEBHOOK", "PAYMENT_USER_DROPPED_WEBHOOK"] as const;

export function eventType(payload: unknown): string | null {
  const body = asRecord(payload);
  return asString(body.type) ?? asString(body.event);
}

/** Cashfree documents an idempotency header (unique per unique payload); the exact name differs between its pages, so both are read. */
export function deliveryId(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): string {
  const fromHeader = headerOf(headers, "x-idempotency-key")?.trim() || headerOf(headers, "x-idempotency-header")?.trim();
  return fromHeader || `sha256:${sha256Hex(rawBody)}`;
}

export interface PaymentInfo {
  cfPaymentId: string | null;
  amount: string | null;
  method: PaymentMethod | null;
  paidAt: Date | null;
  bankReference: string | null;
  message: string | null;
}

export type CashfreeEvent =
  | {
      kind: "link";
      linkId: string;
      linkStatus: "PAID" | "PARTIALLY_PAID" | "EXPIRED" | "CANCELLED" | "OTHER";
      rawStatus: string;
      amountPaid: string | null;
      orderId: string | null;
      crmPaymentId: string | null;
      payment: PaymentInfo | null;
    }
  | { kind: "payment"; outcome: "SUCCESS" | "FAILED" | "DROPPED" | "OTHER"; orderId: string; linkId: string | null; crmPaymentId: string | null; payment: PaymentInfo };

export function methodFromGroup(group: string | null): PaymentMethod | null {
  if (!group) return null;
  const g = group.toLowerCase();
  if (g === "upi") return PaymentMethod.UPI;
  if (["credit_card", "debit_card", "prepaid_card", "emi", "cardless_emi", "card"].includes(g)) return PaymentMethod.CARD;
  if (g === "net_banking" || g === "netbanking") return PaymentMethod.NET_BANKING;
  if (["wallet", "paylater", "pay_later"].includes(g)) return PaymentMethod.WALLET;
  return PaymentMethod.OTHER;
}

function parseTime(value: unknown): Date | null {
  const text = asString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function paymentInfo(raw: unknown): PaymentInfo | null {
  const p = asRecord(raw);
  if (Object.keys(p).length === 0) return null;
  const group = asString(p.payment_group);
  return {
    cfPaymentId: asString(p.cf_payment_id),
    amount: asString(p.payment_amount),
    method: methodFromGroup(group),
    paidAt: parseTime(p.payment_time),
    bankReference: asString(p.bank_reference),
    message: asString(p.payment_message),
  };
}

/** The CRM stamps every link with link_notes.crm_payment / order_tags.crm_payment; when Cashfree echoes it back, it identifies the payment directly. */
function crmPaymentId(...sources: unknown[]): string | null {
  for (const source of sources) {
    const id = asString(asRecord(source).crm_payment);
    if (id) return id;
  }
  return null;
}

export function parseEvent(payload: unknown): CashfreeEvent | null {
  const body = asRecord(payload);
  const type = eventType(payload);
  const data = asRecord(body.data);

  if (type === "PAYMENT_LINK_EVENT") {
    const source = Object.keys(data).length > 0 ? data : body;
    const link = asRecord(source.link).link_id ? asRecord(source.link) : source;
    const linkId = asString(link.link_id);
    const rawStatus = asString(link.link_status);
    if (!linkId || !rawStatus) return null;
    const status = rawStatus.toUpperCase();
    const order = asRecord(source.order);
    return {
      kind: "link",
      linkId,
      linkStatus: status === "PAID" || status === "PARTIALLY_PAID" || status === "EXPIRED" || status === "CANCELLED" ? status : "OTHER",
      rawStatus: status,
      amountPaid: asString(link.link_amount_paid),
      orderId: asString(order.order_id) ?? asString(source.order_id),
      crmPaymentId: crmPaymentId(link.link_notes, source.link_notes),
      payment: paymentInfo(source.payment),
    };
  }

  if (type === "PAYMENT_SUCCESS_WEBHOOK" || type === "PAYMENT_FAILED_WEBHOOK" || type === "PAYMENT_USER_DROPPED_WEBHOOK") {
    const order = asRecord(data.order);
    const orderId = asString(order.order_id);
    const payment = paymentInfo(data.payment);
    if (!orderId || !payment) return null;
    const status = asString(asRecord(data.payment).payment_status)?.toUpperCase() ?? "";
    const outcome = type === "PAYMENT_SUCCESS_WEBHOOK" && status === "SUCCESS" ? "SUCCESS" : type === "PAYMENT_FAILED_WEBHOOK" ? "FAILED" : type === "PAYMENT_USER_DROPPED_WEBHOOK" ? "DROPPED" : "OTHER";
    return {
      kind: "payment",
      outcome,
      orderId,
      linkId: asString(order.link_id) ?? asString(data.link_id),
      crmPaymentId: crmPaymentId(order.order_tags, order.order_meta, data.link_notes),
      payment,
    };
  }
  return null;
}
