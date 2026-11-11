// The external AI calling agency asks the CRM to send a payment link to a customer on WhatsApp. It sends ONLY customerName and mobile. The CRM finds the customer by mobile number, finds their ONE
// eligible COD order (and its amount), creates the payment link with the existing Cashfree payment-link service, and sends it with the existing approved template.
//  - No eligible COD order  -> 404, nothing created.   - More than one -> 409 with the candidates, nothing created (the CRM never guesses which order).
//  - A customer who opted out is never messaged (and no link is created for them).
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
import { maskMobile, requestHash, validateRequest, type AgencyIntent, type FieldError, type PaymentLinkRequest } from "./agency.validators.js";

export interface EligibleOrder {
  id: string;
  leadId: string;
  orderNumber: string;
  /** The Shopify order name (e.g. AWL110598) when the order is linked to Shopify. */
  shopifyOrderNumber: string | null;
  /** What is still to be paid, as a decimal string (e.g. "449.00"). */
  amount: string;
}

export interface PaymentLinkMaker {
  /** The existing CRM payment-link service (Cashfree): creates - or reuses the open - link for the order's outstanding amount. Throws ApiError. */
  createLink(orderId: string): Promise<{ paymentUrl: string | null; amount: string; reused: boolean; expiresAt: Date | null }>;
}

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
  complete(id: string, patch: { status: "SENT" | "RECORDED" | "FAILED" | "REJECTED"; httpStatus: number; response: unknown; errorCode?: string | null; errorMessage?: string | null; leadId?: string | null; orderId?: string | null; messageId?: string | null; providerMessageId?: string | null; templateName?: string | null }, at: Date): Promise<void>;
  /** Rows written for a request that was refused before it could be claimed (invalid body). */
  logRejected(row: { id: string; apiKeyId: string; customerName: string; response: unknown; errorCode: string; errorMessage: string; httpStatus: number; sourceIp: string | null }, at: Date): Promise<void>;
  /** The customer with this mobile number and their orders that can be paid online instead of on delivery (COD, still unpaid, not cancelled / returned / shipped). */
  findEligibleCodOrders(mobile: string): Promise<{ known: boolean; /** Every existing lead with this number, oldest first. */ leadIds: string[]; orders: EligibleOrder[] }>;
  /** Every existing lead with this number, oldest first. No order lookup (used by the INTERESTED intent). */
  findLeadIdsByMobile(mobile: string): Promise<string[]>;
  /** One AI Agent activity per request (updated, never duplicated, when a failed request is retried). Never creates or changes a lead's call / contact state. */
  recordAiAgentActivity(row: AiAgentActivity): Promise<void>;
  /** The customer's WhatsApp consent as the CRM holds it. */
  getConsent(leadId: string): Promise<"OPTED_IN" | "OPTED_OUT" | "UNKNOWN">;
  countSentToLead(leadId: string, since: Date): Promise<number>;
  approvedPaymentLinkTemplates(): Promise<TemplateCandidate[]>;
}

/** What the AI Agent did, as it appears in the lead's activity timeline and the audit trail. */
export interface AiAgentActivity {
  /** The AgencyMessageRequest id: the activity is keyed by it. */
  requestId: string;
  idempotencyKey: string;
  /** ALREADY_ORDERED (payment link) or INTERESTED (only recorded). */
  intent: AgencyIntent;
  /** The matched lead; null when the number belongs to no lead (the CRM never creates one for this API). */
  leadId: string | null;
  orderId: string | null;
  customerName: string;
  normalizedMobile: string;
  /** PAYMENT_LINK_SENT or the error code (CUSTOMER_NOT_FOUND, NO_ELIGIBLE_ORDER, MULTIPLE_ELIGIBLE_ORDERS, ...). */
  result: string;
  httpStatus: number;
  apiKeyName: string;
  at: Date;
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
  preferredTemplate: string | null;
  /** true: only a customer the CRM has an explicit OPTED_IN record for is messaged. false (default): everyone except OPTED_OUT - the message is about the customer's own existing order. */
  requireExplicitOptIn: boolean;
}

export const DEFAULT_OPTIONS: AgencyOptions = { perRecipientPerHour: 3, autoDedupeWindowMs: 10 * 60_000, preferredTemplate: null, requireExplicitOptIn: false };

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
    private readonly links: PaymentLinkMaker,
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

    const checked = validateRequest(input.body);
    if (!checked.value) return this.reject(requestId, key, input.body, input.sourceIp, 400, "VALIDATION_FAILED", "The request is not valid", checked.errors);
    const request = checked.value;
    const hash = requestHash(request);
    const toMasked = maskMobile(request.mobile);

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

    const claim = await this.repo.claim({ id: requestId, apiKeyId: key.id, idempotencyKey: usedKey, requestHash: hash, customerName: request.customerName, toMasked, linkHost: "-", orderRef: null, sourceIp: input.sourceIp });
    let activeId = requestId;
    if (!claim.created) {
      const existing = claim.existing!;
      if (existing.requestHash !== hash) {
        return { httpStatus: 409, body: failureBody(requestId, { code: "IDEMPOTENCY_KEY_REUSED", message: "This Idempotency-Key was already used for a different request. Use a new key for a new request." }) };
      }
      if (existing.status === "FAILED" && (await this.repo.reclaimFailed(existing.id))) activeId = existing.id; // a failed attempt may be retried with the same key
      else return this.replay(existing, requestId);
    }

    if (request.intent === "INTERESTED") return this.interested(activeId, key, request, usedKey, toMasked);

    try {
      const sent = await this.process(activeId, request);
      const body = { success: true, requestId: activeId, status: sent.status, duplicate: false, message: { id: sent.messageId, whatsappMessageId: sent.providerMessageId, template: sent.templateName, to: toMasked }, order: sent.order, payment: sent.payment };
      await this.repo.complete(activeId, { status: "SENT", httpStatus: 200, response: body, leadId: sent.leadId, orderId: sent.orderId, messageId: sent.messageId, providerMessageId: sent.providerMessageId, templateName: sent.templateName }, this.now());
      logger.info(`[agency] ${activeId} key="${key.name}" SENT to ${toMasked} template=${sent.templateName}`);
      await this.recordActivity({ requestId: activeId, idempotencyKey: usedKey, leadId: sent.leadId, orderId: sent.orderId, customerName: request.customerName, normalizedMobile: request.mobile, result: "PAYMENT_LINK_SENT", httpStatus: 200, apiKeyName: key.name, intent: request.intent });
      return { httpStatus: 200, body };
    } catch (error) {
      const f = this.toFailure(error);
      const body = failureBody(activeId, f);
      await this.repo.complete(activeId, { status: "FAILED", httpStatus: f.httpStatus, response: body, errorCode: f.code, errorMessage: f.message.slice(0, 1000), ...("ids" in f ? (f as { ids: object }).ids : {}) }, this.now()).catch((e) => logger.error(`[agency] could not store the outcome of ${activeId}`, e instanceof Error ? e.message : e));
      logger.warn(`[agency] ${activeId} key="${key.name}" FAILED ${f.code} to ${toMasked}: ${f.message}`);
      const ids = (f as { ids?: { leadId?: string | null; orderId?: string | null } }).ids ?? {};
      await this.recordActivity({ requestId: activeId, idempotencyKey: usedKey, leadId: ids.leadId ?? null, orderId: ids.orderId ?? null, customerName: request.customerName, normalizedMobile: request.mobile, result: f.code, httpStatus: f.httpStatus, apiKeyName: key.name, intent: request.intent });
      return { httpStatus: f.httpStatus, body };
    }
  }

  /**
   * INTERESTED: the customer said they are interested. Nothing is looked up besides the lead, nothing is created and nothing is sent: no order search, no Cashfree link, no WhatsApp message. The request is only
   * recorded (as an AI Agent activity on the matched lead, or - when the number belongs to no lead - with no lead, visible in the admin audit trail). The lead itself is never changed.
   */
  private async interested(activeId: string, key: AgencyKeyRow, request: PaymentLinkRequest, usedKey: string, toMasked: string): Promise<AgencyResponse> {
    try {
      const leadId = (await this.repo.findLeadIdsByMobile(request.mobile))[0] ?? null;
      const result = leadId ? "INTERESTED_RECORDED" : "INTERESTED_NO_LEAD";
      const body = { success: true, requestId: activeId, status: "RECORDED", duplicate: false, intent: "INTERESTED", leadMatched: leadId !== null };
      await this.repo.complete(activeId, { status: "RECORDED", httpStatus: 200, response: body, leadId }, this.now());
      logger.info(`[agency] ${activeId} key="${key.name}" INTERESTED ${result} for ${toMasked}`);
      await this.recordActivity({ requestId: activeId, idempotencyKey: usedKey, leadId, orderId: null, customerName: request.customerName, normalizedMobile: request.mobile, result, httpStatus: 200, apiKeyName: key.name, intent: "INTERESTED" });
      return { httpStatus: 200, body };
    } catch (error) {
      const f = this.toFailure(error);
      const body = failureBody(activeId, f);
      await this.repo.complete(activeId, { status: "FAILED", httpStatus: f.httpStatus, response: body, errorCode: f.code, errorMessage: f.message.slice(0, 1000) }, this.now()).catch((e) => logger.error(`[agency] could not store the outcome of ${activeId}`, e instanceof Error ? e.message : e));
      return { httpStatus: f.httpStatus, body };
    }
  }

  private async process(requestId: string, request: PaymentLinkRequest): Promise<{ status: string; messageId: string; providerMessageId: string | null; templateName: string | null; leadId: string; orderId: string | null; order: Record<string, unknown>; payment: Record<string, unknown> }> {
    // 1. The customer and the ONE order this is about. Never guessed: none -> not found, several -> the candidates are returned and nothing is created.
    const found = await this.repo.findEligibleCodOrders(request.mobile);
    if (!found.known) throw new Failure(404, "CUSTOMER_NOT_FOUND", "No customer with this mobile number exists in the CRM, so no payment link was created.");
    if (found.orders.length === 0) throw Object.assign(new Failure(404, "NO_ELIGIBLE_ORDER", "This customer has no COD order that can be paid online (it must be an unpaid COD order that is not cancelled, returned or already shipped). No payment link was created."), { ids: { leadId: found.leadIds[0] ?? null, orderId: null } });
    if (found.orders.length > 1) {
      throw Object.assign(new Failure(409, "MULTIPLE_ELIGIBLE_ORDERS", "This customer has more than one eligible COD order, so the CRM did not choose one and created no payment link. Resolve it with the CRM team.", { orders: found.orders.map((o) => ({ orderNumber: o.orderNumber, shopifyOrderNumber: o.shopifyOrderNumber, amount: o.amount })) }), { ids: { leadId: found.leadIds[0] ?? null, orderId: null } });
    }
    const order = found.orders[0]!;
    const leadId = order.leadId;
    const ids = { leadId, orderId: order.id };

    // 2. Consent, before anything is created or sent: an opted-out customer is never messaged; in strict mode only an explicit opt-in is.
    const consent = await this.repo.getConsent(leadId);
    if (consent === "OPTED_OUT") throw Object.assign(new Failure(422, "CUSTOMER_OPTED_OUT", "This customer has opted out of WhatsApp messages, so nothing was created or sent."), { ids });
    if (this.options.requireExplicitOptIn && consent !== "OPTED_IN") throw Object.assign(new Failure(422, "CONSENT_NOT_RECORDED", "The CRM has no recorded WhatsApp consent for this customer, so nothing was created or sent."), { ids });

    const sentLastHour = await this.repo.countSentToLead(leadId, new Date(this.now().getTime() - 3_600_000));
    if (sentLastHour >= this.options.perRecipientPerHour) throw Object.assign(new Failure(429, "RECIPIENT_LIMIT", `This customer has already been sent ${sentLastHour} payment-link messages in the last hour. Try again later.`, undefined, true), { ids });

    // 3. A template must exist BEFORE a link is created, so a missing template never leaves a link nobody was told about.
    if ((await this.repo.approvedPaymentLinkTemplates()).length === 0) throw Object.assign(new Failure(503, "NO_APPROVED_TEMPLATE", "No approved WhatsApp template containing {{payment_link}} is set up in the CRM. The CRM team must create and get one approved by Meta.", undefined, true), { ids });

    // 4. The payment link, from the existing CRM payment-link service (repeating this reuses the same open link for the same amount).
    let link;
    try {
      link = await this.links.createLink(order.id);
    } catch (error) {
      throw Object.assign(this.linkFailure(error), { ids });
    }
    if (!link.paymentUrl) throw Object.assign(new Failure(502, "PAYMENT_LINK_FAILED", "The payment gateway did not return a payment link. Nothing was sent; retry with the same Idempotency-Key.", undefined, true), { ids });
    const paymentUrl = link.paymentUrl;

    // 5. The message, through the existing approved template.
    const manualValues: Record<string, string> = { customer_name: request.customerName, payment_link: paymentUrl, order_number: order.shopifyOrderNumber ?? order.orderNumber, amount: link.amount };
    const picked = await this.pickTemplate(leadId, order.id, manualValues).catch((e: unknown) => { throw Object.assign(e as Error, { ids }); });
    let message;
    try {
      message = await this.messaging.sendTemplateAsAgency({ leadId, templateId: picked.id, orderId: order.id, manualValues });
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
    // repeated); when it carried something else, this request was not sent and must not be reported as sent.
    if (!message.body || !message.body.includes(paymentUrl)) {
      throw Object.assign(new Failure(409, "RECENT_MESSAGE_CONFLICT", "A different message was sent to this customer a few seconds ago, so this one was not sent. Retry in a minute.", undefined, true), { ids });
    }
    void requestId;
    return {
      status: message.status, messageId: message.id, providerMessageId: message.providerMessageId, templateName: message.templateName ?? picked.name, leadId, orderId: order.id,
      order: { orderNumber: order.orderNumber, shopifyOrderNumber: order.shopifyOrderNumber },
      payment: { amount: link.amount, currency: "INR", expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null, reusedExistingLink: link.reused },
    };
  }

  /** Best effort: the activity is a record of the request, never a reason for the request itself to fail (or to be answered differently). */
  private async recordActivity(row: Omit<AiAgentActivity, "at">): Promise<void> {
    try {
      await this.repo.recordAiAgentActivity({ ...row, at: this.now() });
    } catch (error) {
      logger.error(`[agency] could not record the AI Agent activity of ${row.requestId}`, error instanceof Error ? error.message : String(error));
    }
  }

  /** What the CRM's payment-link service said, turned into a stable code. */
  private linkFailure(error: unknown): Failure {
    if (error instanceof ApiError) {
      if (error.statusCode === 409) return new Failure(409, "PAYMENT_LINK_CONFLICT", error.message);
      if (error.statusCode >= 400 && error.statusCode < 500) return new Failure(422, "ORDER_NOT_PAYABLE", error.message);
      return new Failure(502, "PAYMENT_LINK_FAILED", error.message, undefined, true);
    }
    logger.error("[agency] payment link creation failed", error instanceof Error ? error.message : String(error));
    return new Failure(502, "PAYMENT_LINK_FAILED", "The payment link could not be created. Nothing was sent; retry with the same Idempotency-Key.", undefined, true);
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
    throw new Failure(422, "MISSING_TEMPLATE_PARAMETERS", `The WhatsApp template needs values this request could not fill${bestMissing && bestMissing.length ? `: ${bestMissing.join(", ")}` : ""}. The CRM team must adjust the template.`, { missing: bestMissing ?? [] });
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
