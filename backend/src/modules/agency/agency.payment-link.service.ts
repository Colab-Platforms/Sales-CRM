// The external AI calling agency asks the CRM to send a payment link to a customer on WhatsApp.
//
// This is NOT a second WhatsApp integration: the message goes out through WhatsAppMessagingService.sendTemplateAsAgency - the same send() every other customer message uses, over the
// Meta Cloud API credentials saved in Settings -> WhatsApp Config. What is added here is only what an outside caller needs around it: request validation, idempotency, the customer's
// consent, a per-customer cap, template choice and a log row per request.
//
// Meta policy: a business-initiated message to a customer outside the 24-hour customer-service window may only be an APPROVED template. This API therefore ALWAYS sends an approved Meta template
// (it never sends free text), which is valid inside and outside the window. A customer who has opted out of WhatsApp is never messaged.
import { randomUUID } from "node:crypto";
import { ApiError } from "@/utils/apiError.js";
import { logger } from "@/utils/logger.js";
import { maskMobile, requestHash, validateRequest, type FieldError, type PaymentLinkRequest } from "./agency.validators.js";

export interface AgencyKeyRow {
  id: string;
  name: string;
  isActive: boolean;
  revokedAt: Date | null;
  rateLimitPerMinute: number;
}

export interface StoredRequest {
  id: string;
  status: string;
  requestHash: string;
  httpStatus: number | null;
  response: unknown;
  createdAt: Date;
}

export interface TemplateCandidate {
  id: string;
  name: string;
}

export interface AgencyRepo {
  findKeyByHash(hash: string): Promise<AgencyKeyRow | null>;
  touchKey(id: string, at: Date): Promise<void>;
  /** Inserts the request row, or returns the row that already holds this (key, idempotency key). */
  claim(row: { id: string; apiKeyId: string; idempotencyKey: string; requestHash: string; customerName: string; toMasked: string; linkHost: string; orderRef: string | null; sourceIp: string | null }): Promise<{ created: boolean; existing: StoredRequest | null }>;
  /** A FAILED request retried with the same idempotency key becomes RECEIVED again; false when someone else already did. */
  reclaimFailed(id: string): Promise<boolean>;
  /** A request of this key and fingerprint that was already sent / is still running, newer than `since`. */
  findRecentSameRequest(apiKeyId: string, hash: string, since: Date): Promise<StoredRequest | null>;
  complete(id: string, patch: { status: "SENT" | "FAILED" | "REJECTED"; httpStatus: number; response: unknown; errorCode?: string | null; errorMessage?: string | null; leadId?: string | null; orderId?: string | null; messageId?: string | null; providerMessageId?: string | null; templateName?: string | null }, at: Date): Promise<void>;
  /** Rows written for a request that was refused before it could be claimed (invalid body). */
  logRejected(row: { id: string; apiKeyId: string; customerName: string; response: unknown; errorCode: string; errorMessage: string; httpStatus: number; sourceIp: string | null }, at: Date): Promise<void>;
  findLeadByMobile(mobile: string): Promise<{ id: string; normalizedMobile: string | null } | null>;
  createLead(input: { customerName: string; mobile: string }): Promise<{ id: string }>;
  /** The order a reference points to (CRM order number, Shopify name such as AWL110598, or id) with the customer it belongs to. */
  findOrder(ref: string): Promise<{ id: string; leadId: string; leadMobile: string | null } | null>;
  /** OPTED_OUT stays OPTED_OUT. Otherwise the customer is recorded as opted in via the agency (their consent on the call). Returns the status that applies. */
  recordConsent(leadId: string, at: Date): Promise<"OPTED_IN" | "OPTED_OUT">;
  countSentToLead(leadId: string, since: Date): Promise<number>;
  approvedPaymentLinkTemplates(): Promise<TemplateCandidate[]>;
}

export interface AgencyMessaging {
  describeAgencySend(input: { leadId: string; templateId: string; orderId?: string; manualValues?: Record<string, string> }): Promise<{ errors: string[]; fields: { name: string; value: string | null }[]; templateName: string }>;
  sendTemplateAsAgency(input: { leadId: string; templateId: string; orderId?: string; manualValues?: Record<string, string> }): Promise<{ id: string; status: string; providerMessageId: string | null; templateName: string | null; body: string | null; errorMessage: string | null }>;
}

export interface AgencyOptions {
  /** Messages one customer may be sent per hour through this API, across all requests. */
  perRecipientPerHour: number;
  /** Without an Idempotency-Key, an identical request inside this window is treated as the same request. */
  autoDedupeWindowMs: number;
  allowedHosts: string[];
  preferredTemplate: string | null;
}

export const DEFAULT_OPTIONS: AgencyOptions = { perRecipientPerHour: 3, autoDedupeWindowMs: 10 * 60_000, allowedHosts: [], preferredTemplate: null };

export interface AgencyResponse {
  httpStatus: number;
  body: Record<string, unknown>;
  retryAfterSeconds?: number;
}

class Failure extends Error {
  constructor(readonly httpStatus: number, readonly code: string, message: string, readonly details?: unknown, readonly retryable = false) {
    super(message);
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

function failureBody(requestId: string, f: { code: string; message: string; details?: unknown; retryable?: boolean }): Record<string, unknown> {
  return { success: false, requestId, error: { code: f.code, message: f.message, ...(f.details !== undefined ? { details: f.details } : {}), ...(f.retryable !== undefined ? { retryable: f.retryable } : {}) } };
}

/** What Meta / the send path said, turned into a stable code. The text is already redacted by the Meta provider. */
export function classifySendError(message: string | null): { httpStatus: number; code: string; retryable: boolean } {
  const text = message ?? "";
  if (/could not reach meta|timed out|timeout|network/i.test(text)) return { httpStatus: 502, code: "WHATSAPP_UNREACHABLE", retryable: true };
  const http = /HTTP (\d{3})/.exec(text)?.[1];
  const status = http ? Number(http) : null;
  if (status === 429 || /rate limit|too many/i.test(text)) return { httpStatus: 502, code: "WHATSAPP_RATE_LIMITED", retryable: true };
  if (status !== null && status >= 500) return { httpStatus: 502, code: "WHATSAPP_UNAVAILABLE", retryable: true };
  if (status === 401 || status === 403 || /access token|permission|OAuth/i.test(text)) return { httpStatus: 502, code: "WHATSAPP_AUTH_ERROR", retryable: false };
  if (/131026|not a valid whatsapp|undeliverable|incapable|not in allowed list|recipient/i.test(text)) return { httpStatus: 422, code: "RECIPIENT_NOT_REACHABLE", retryable: false };
  if (/template|132000|132001|132005|132007|132012|132015|132016/i.test(text)) return { httpStatus: 502, code: "TEMPLATE_REJECTED", retryable: false };
  return { httpStatus: 502, code: "WHATSAPP_REJECTED", retryable: false };
}

export class AgencyPaymentLinkService {
  constructor(
    private readonly repo: AgencyRepo,
    private readonly messaging: AgencyMessaging,
    private readonly options: AgencyOptions = DEFAULT_OPTIONS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async handle(input: { key: AgencyKeyRow; body: unknown; idempotencyKeyHeader: string | undefined; sourceIp: string | null }): Promise<AgencyResponse> {
    const requestId: string = randomUUID();
    const { key } = input;

    const idempotencyKey = input.idempotencyKeyHeader?.trim() || null;
    if (idempotencyKey && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return this.reject(requestId, key, input.body, input.sourceIp, 400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 8 to 128 characters: letters, digits and . _ : -");
    }

    const checked = validateRequest(input.body, this.options.allowedHosts.length > 0 ? this.options.allowedHosts : undefined);
    if (!checked.value) return this.reject(requestId, key, input.body, input.sourceIp, 400, "VALIDATION_FAILED", "The request is not valid", checked.errors);
    const request = checked.value;
    const hash = requestHash(request);
    const toMasked = maskMobile(request.mobile);
    const linkHost = checked.linkHost ?? "";

    // Duplicate protection. With an Idempotency-Key: the same key + same request returns the first answer, the same key + a different request is refused. Without one: an identical request from this
    // key inside a few minutes is the same request.
    let usedKey = idempotencyKey;
    if (!usedKey) {
      const since = new Date(this.now().getTime() - this.options.autoDedupeWindowMs);
      const same = await this.repo.findRecentSameRequest(key.id, hash, since);
      if (same) return this.replay(same, requestId);
      // Derived from the request itself and the current window, so identical requests arriving at the same moment collide on the table's unique (key, idempotency key) and only one proceeds.
      usedKey = `auto:${hash}:${Math.floor(this.now().getTime() / this.options.autoDedupeWindowMs)}`;
    }

    const claim = await this.repo.claim({ id: requestId, apiKeyId: key.id, idempotencyKey: usedKey, requestHash: hash, customerName: request.customerName, toMasked, linkHost, orderRef: request.orderId, sourceIp: input.sourceIp });
    let activeId = requestId;
    if (!claim.created) {
      const existing = claim.existing!;
      if (existing.requestHash !== hash) {
        return { httpStatus: 409, body: failureBody(requestId, { code: "IDEMPOTENCY_KEY_REUSED", message: "This Idempotency-Key was already used for a different request. Use a new key for a new request." }) };
      }
      if (existing.status === "FAILED" && (await this.repo.reclaimFailed(existing.id))) activeId = existing.id; // a failed attempt may be retried with the same key
      else return this.replay(existing, requestId);
    }

    try {
      const sent = await this.process(activeId, request);
      const body = { success: true, requestId: activeId, status: sent.status, duplicate: false, message: { id: sent.messageId, whatsappMessageId: sent.providerMessageId, template: sent.templateName, to: toMasked } };
      await this.repo.complete(activeId, { status: "SENT", httpStatus: 200, response: body, leadId: sent.leadId, orderId: sent.orderId, messageId: sent.messageId, providerMessageId: sent.providerMessageId, templateName: sent.templateName }, this.now());
      logger.info(`[agency] ${activeId} key="${key.name}" SENT to ${toMasked} template=${sent.templateName}`);
      return { httpStatus: 200, body };
    } catch (error) {
      const f = this.toFailure(error);
      const body = failureBody(activeId, f);
      await this.repo.complete(activeId, { status: "FAILED", httpStatus: f.httpStatus, response: body, errorCode: f.code, errorMessage: f.message.slice(0, 1000), ...("ids" in f ? (f as { ids: object }).ids : {}) }, this.now()).catch((e) => logger.error(`[agency] could not store the outcome of ${activeId}`, e instanceof Error ? e.message : e));
      logger.warn(`[agency] ${activeId} key="${key.name}" FAILED ${f.code} to ${toMasked}: ${f.message}`);
      return { httpStatus: f.httpStatus, body };
    }
  }

  private async process(requestId: string, request: PaymentLinkRequest): Promise<{ status: string; messageId: string; providerMessageId: string | null; templateName: string | null; leadId: string; orderId: string | null }> {
    // The order, when one was named and exists in the CRM: it must be this customer's. An id the CRM does not know is only the agency's own reference.
    const order = request.orderId ? await this.repo.findOrder(request.orderId) : null;
    if (order && order.leadMobile && order.leadMobile !== request.mobile) throw new Failure(422, "ORDER_MOBILE_MISMATCH", "This orderId belongs to a different mobile number, so nothing was sent.");

    const lead = order ? { id: order.leadId } : (await this.repo.findLeadByMobile(request.mobile)) ?? (await this.repo.createLead({ customerName: request.customerName, mobile: request.mobile }));

    // Consent: a customer who opted out is never messaged; otherwise the agency's attestation (customerConsent: true) is recorded as the opt-in.
    if ((await this.repo.recordConsent(lead.id, this.now())) === "OPTED_OUT") throw new Failure(422, "CUSTOMER_OPTED_OUT", "This customer has opted out of WhatsApp messages, so nothing was sent.");

    const sentLastHour = await this.repo.countSentToLead(lead.id, new Date(this.now().getTime() - 3_600_000));
    if (sentLastHour >= this.options.perRecipientPerHour) throw new Failure(429, "RECIPIENT_LIMIT", `This customer has already been sent ${sentLastHour} payment-link messages in the last hour. Try again later.`, undefined, true);

    const manualValues: Record<string, string> = { ...request.templateParams, customer_name: request.customerName, payment_link: request.paymentLink };
    if (request.orderId && !order && !manualValues.order_number) manualValues.order_number = request.orderId;

    const picked = await this.pickTemplate(lead.id, order?.id, manualValues);
    const send = { leadId: lead.id, templateId: picked.id, ...(order ? { orderId: order.id } : {}), manualValues };
    const ids = { leadId: lead.id, orderId: order?.id ?? null };

    let message;
    try {
      message = await this.messaging.sendTemplateAsAgency(send);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 503) throw Object.assign(new Failure(503, "WHATSAPP_NOT_CONFIGURED", "WhatsApp is not configured on the CRM side. The CRM team has been notified by this failure; try again later.", undefined, true), { ids });
      if (error instanceof ApiError) throw Object.assign(new Failure(422, "SEND_REFUSED", error.message), { ids });
      throw error;
    }
    if (message.status === "FAILED") {
      const c = classifySendError(message.errorMessage);
      throw Object.assign(new Failure(c.httpStatus, c.code, message.errorMessage ?? "WhatsApp rejected the message", undefined, c.retryable), { ids: { ...ids, messageId: message.id, providerMessageId: message.providerMessageId, templateName: message.templateName } });
    }
    // The send path suppresses an identical template send to the same customer inside 30 seconds and hands back the earlier message. That is fine when it carried THIS link (the same request
    // repeated); when it carried another link, this request was not sent and must not be reported as sent.
    if (!message.body || !message.body.includes(request.paymentLink)) {
      throw Object.assign(new Failure(409, "RECENT_MESSAGE_CONFLICT", "A different message was sent to this customer a few seconds ago, so this one was not sent. Retry in a minute.", undefined, true), { ids });
    }
    void requestId;
    return { status: message.status, messageId: message.id, providerMessageId: message.providerMessageId, templateName: message.templateName ?? picked.name, leadId: lead.id, orderId: order?.id ?? null };
  }

  /** The approved Meta template to use: the configured one first, then the others; the first whose variables can ALL be filled from this request. */
  private async pickTemplate(leadId: string, orderId: string | undefined, manualValues: Record<string, string>): Promise<TemplateCandidate> {
    const all = await this.repo.approvedPaymentLinkTemplates();
    if (all.length === 0) throw new Failure(503, "NO_APPROVED_TEMPLATE", "No approved WhatsApp template containing {{payment_link}} is set up in the CRM. The CRM team must create and get one approved by Meta.", undefined, true);
    const preferred = this.options.preferredTemplate;
    const ordered = preferred ? [...all.filter((t) => t.name === preferred), ...all.filter((t) => t.name !== preferred)] : all;
    let bestMissing: string[] | null = null;
    for (const candidate of ordered) {
      try {
        const described = await this.messaging.describeAgencySend({ leadId, templateId: candidate.id, ...(orderId ? { orderId } : {}), manualValues });
        if (described.errors.length === 0) return candidate;
        const missing = described.fields.filter((f) => f.value === null).map((f) => f.name);
        if (!bestMissing || missing.length < bestMissing.length) bestMissing = missing;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
      }
    }
    throw new Failure(422, "MISSING_TEMPLATE_PARAMETERS", `The WhatsApp template needs values this request did not provide${bestMissing && bestMissing.length ? `: ${bestMissing.join(", ")}` : ""}. Send them in templateParams.`, { missing: bestMissing ?? [] });
  }

  private toFailure(error: unknown): Failure & { ids?: object } {
    if (error instanceof Failure) return error;
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[agency] unexpected error", message);
    return new Failure(500, "INTERNAL_ERROR", "The CRM could not process this request. Nothing was confirmed as sent; retry with the same Idempotency-Key.", undefined, true);
  }

  private replay(stored: StoredRequest, requestId: string): AgencyResponse {
    if (stored.status === "RECEIVED" || stored.response === null || stored.response === undefined) {
      return { httpStatus: 409, body: failureBody(requestId, { code: "REQUEST_IN_PROGRESS", message: "An identical request is still being processed. Wait a few seconds and repeat it with the same Idempotency-Key.", details: { originalRequestId: stored.id }, retryable: true }), retryAfterSeconds: 3 };
    }
    const first = stored.response as Record<string, unknown>;
    return { httpStatus: stored.httpStatus ?? 200, body: { ...first, duplicate: true, requestId: stored.id } };
  }

  private async reject(requestId: string, key: AgencyKeyRow, body: unknown, sourceIp: string | null, httpStatus: number, code: string, message: string, details?: FieldError[]): Promise<AgencyResponse> {
    const response = failureBody(requestId, { code, message, details });
    const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    await this.repo
      .logRejected({ id: requestId, apiKeyId: key.id, customerName: typeof raw.customerName === "string" ? raw.customerName.slice(0, 200) : "", response, errorCode: code, errorMessage: message, httpStatus, sourceIp }, this.now())
      .catch((e) => logger.error("[agency] could not log a rejected request", e instanceof Error ? e.message : e));
    logger.info(`[agency] ${requestId} key="${key.name}" REJECTED ${code}`);
    return { httpStatus, body: response };
  }
}
