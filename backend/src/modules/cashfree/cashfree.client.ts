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

  private async call(method: "GET" | "POST", path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<unknown> {
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

  async cancelLink(linkId: string): Promise<CashfreeLink | null> {
    return parseLink(await this.call("POST", `/links/${encodeURIComponent(linkId)}/cancel`));
  }
}
