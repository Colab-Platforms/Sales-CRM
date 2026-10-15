import { logger } from "@/utils/logger.js";
import { createHash } from "node:crypto";
import { parseMetaMedia } from "./whatsapp.media.js";
import { verifyMetaSignature } from "./whatsapp.hmac.js";
import { isObject, metaCloudApiMessages } from "./whatsapp.meta.envelope.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type {
  NormalizedIncomingMessage,
  NormalizedStatusUpdate,
  NormalizedTemplate,
  ProviderTemplateStatus,
  RawWebhookRequest,
  SendTemplateMessageInput,
  SendTemplateMessageResult,
  TemplateSyncResult,
  WhatsAppDeliveryStatus,
  WhatsAppProvider,
} from "./whatsapp.provider.js";

// The official Meta WhatsApp Cloud API, called directly - no BSP in between. Confirmed against
// Meta's published Graph API reference: POST /{phoneNumberId}/messages, Bearer access token, a
// configured Graph API version in the URL path. Credentials come from the DB-stored WhatsAppConfig
// (whatsapp.meta.factory.ts), decrypted just before use - never from env vars, unlike
// AiSensyProvider/GupshupProvider above.

import { redactDeep, redactSecrets } from "./whatsapp.redact.js";

export interface MetaCloudApiCredentials {
  readonly phoneNumberId: string;
  readonly businessAccountId: string;
  readonly accessToken: string;
  readonly appSecret: string;
  readonly verifyToken: string;
  readonly graphApiVersion: string;
}

const STATUS_MAP: Record<string, WhatsAppDeliveryStatus> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

// Meta's documented template-status values on GET /{businessAccountId}/message_templates.
const TEMPLATE_STATUS_MAP: Record<string, ProviderTemplateStatus> = {
  approved: "APPROVED",
  pending: "PENDING",
  rejected: "REJECTED",
  paused: "DISABLED",
  disabled: "DISABLED",
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const REQUEST_TIMEOUT_MS = 10_000;

export interface MetaTextMessage {
  to: string;
  body: string;
  previewUrl?: boolean;
  /** Meta's documented `context.message_id` - the wamid of the message this one replies to, shown
   *  as a quoted reply in the customer's WhatsApp. Confirmed real Meta Cloud API capability (the same
   *  field inbound webhooks already report back as context.id, read by parseIncomingWebhook). */
  replyToMessageId?: string;
}

export interface MetaMediaMessage {
  to: string;
  /** Must already be a publicly accessible https URL - this module has no file-hosting service of its own. */
  link: string;
  caption?: string;
  filename?: string;
}

export interface MetaInteractiveMessage {
  to: string;
  /** Passed through as Meta's documented `interactive` object verbatim (button/list/etc.) - this
   *  module does not constrain its shape, since Meta's interactive message types evolve independently. */
  interactive: Record<string, unknown>;
}

export interface MetaCatalogMessage {
  to: string;
  catalogId: string;
  bodyText?: string;
  /** When omitted, sends the whole catalog (Meta's `catalog_message` with no product list); when
   *  given, sends a curated product list (`product_list`) instead - both are documented interactive types. */
  sections?: { title: string; productRetailerIds: string[] }[];
}

// No deleteMessage()/recallMessage() method exists on this provider, and none should be added: the
// current WhatsApp Cloud API reference documents no endpoint for a business to delete, recall, or
// unsend an already-sent message (verified against graph.facebook.com's Messages and Webhooks
// reference docs - only POST /{phoneNumberId}/messages for sending, and DELETE /{media-id} for an
// uploaded media asset, which is unrelated). See whatsapp.message-actions.service.ts's header comment
// for the full capability finding across all configured providers.
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 30_000;
/** Hosts Meta serves WhatsApp media from (and the Graph API itself). The access token is never sent anywhere else. */
const META_MEDIA_HOST_SUFFIXES = [".facebook.com", ".fbcdn.net", ".fbsbx.com", ".whatsapp.net", ".whatsapp.com"];

export function isMetaMediaUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return host === "graph.facebook.com" || META_MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

export type WhatsAppMediaFailure = "NOT_FOUND" | "TOO_LARGE" | "UNAVAILABLE" | "INTEGRITY";

/** A media download that could not be completed. `kind` tells the caller which HTTP answer fits; the message is safe to show. */
export class WhatsAppMediaError extends Error {
  constructor(
    message: string,
    readonly kind: WhatsAppMediaFailure,
  ) {
    super(message);
    this.name = "WhatsAppMediaError";
  }
}

export interface FetchedMedia {
  buffer: Buffer;
  mimeType: string | null;
  /** true = matched the checksum Meta reported; null = Meta reported none. (A mismatch throws.) */
  checksumVerified: boolean | null;
}

export class MetaCloudApiProvider implements WhatsAppProvider {
  readonly id = "META" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: MetaCloudApiCredentials,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Provider text made safe to store, return or log: this adapter's own credentials and any credential-shaped text are redacted. */
  private safe(text: string): string {
    return redactSecrets(text, [this.config.accessToken, this.config.appSecret, this.config.verifyToken]);
  }

  private messagesUrl(): string {
    return `https://graph.facebook.com/${this.config.graphApiVersion}/${this.config.phoneNumberId}/messages`;
  }

  /** Never the token/Authorization header, never the full recipient number - just enough to diagnose a
   *  rejected send from server logs (dev or prod) without exposing a secret or a customer's real number. */
  private sanitizedForLog(body: Record<string, unknown>): unknown {
    const masked = { ...body } as Record<string, unknown>;
    if (typeof masked.to === "string") masked.to = masked.to.replace(/\d(?=\d{2})/g, "*");
    return masked;
  }

  private async post(body: Record<string, unknown>, label: string): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.messagesUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.accessToken}` },
          body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        lastError = error;
        logger.error(`Meta Cloud API ${label} send failed to reach Graph API`, this.safe(error instanceof Error ? error.message : String(error)));
        continue; // network failure - retry once
      }

      const parsed = await response.json().catch(() => null);
      if (response.ok) return isObject(parsed) ? parsed : {};

      if (RETRYABLE_STATUS.has(response.status) && attempt === 0) {
        lastError = parsed;
        continue; // rate-limited/transient - retry once
      }
      // Sanitized diagnostic log (no token, masked recipient) - Meta's own error body is never a secret,
      // it's what actually explains a rejected send (wrong parameter format, unapproved template, etc.).
      logger.error(`Meta Cloud API rejected the ${label} message (HTTP ${response.status})`, { request: this.sanitizedForLog(body), metaError: redactDeep(isObject(parsed) ? parsed.error : parsed, [this.config.accessToken, this.config.appSecret, this.config.verifyToken]) });
      throw new WhatsAppSendError(this.safe(`Meta Cloud API rejected the ${label} message (HTTP ${response.status}): ${describeMetaError(parsed)}`), redactDeep(parsed, [this.config.accessToken, this.config.appSecret, this.config.verifyToken]));
    }
    throw new WhatsAppSendError(this.safe(`Could not reach Meta Cloud API for ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`), redactDeep(lastError instanceof Error ? lastError.message : lastError, [this.config.accessToken, this.config.appSecret, this.config.verifyToken]));
  }

  async sendTemplateMessage(input: SendTemplateMessageInput): Promise<SendTemplateMessageResult> {
    // Every template this CRM submits to Meta uses parameter_format: "named" (whatsapp.template.meta-payload.ts) -
    // Meta's Send Message API rejects a named-format template sent with positional-only parameters (no
    // parameter_name), which is exactly the HTTP 400 this fixes. Falls back to positional only if the caller
    // genuinely has no names (never the case for a send this service originates).
    const components =
      input.params.length > 0
        ? [
            {
              type: "body",
              parameters: input.params.map((text, i) => {
                const name = input.paramNames?.[i];
                return name ? { type: "text", parameter_name: name, text } : { type: "text", text };
              }),
            },
          ]
        : [];
    const body = await this.post(
      {
        to: input.to,
        type: "template",
        template: { name: input.templateName, language: { code: input.languageCode ?? "en" }, components },
      },
      "template",
    );
    return { providerMessageId: firstMessageId(body), raw: body };
  }

  async sendText(input: MetaTextMessage): Promise<SendTemplateMessageResult> {
    const body = await this.post(
      {
        to: input.to,
        type: "text",
        text: { body: input.body, preview_url: input.previewUrl ?? false },
        ...(input.replyToMessageId ? { context: { message_id: input.replyToMessageId } } : {}),
      },
      "text",
    );
    return { providerMessageId: firstMessageId(body), raw: body };
  }

  async sendImage(input: MetaMediaMessage): Promise<SendTemplateMessageResult> {
    const body = await this.post({ to: input.to, type: "image", image: { link: input.link, caption: input.caption } }, "image");
    return { providerMessageId: firstMessageId(body), raw: body };
  }

  async sendDocument(input: MetaMediaMessage): Promise<SendTemplateMessageResult> {
    const body = await this.post({ to: input.to, type: "document", document: { link: input.link, caption: input.caption, filename: input.filename } }, "document");
    return { providerMessageId: firstMessageId(body), raw: body };
  }

  async sendInteractive(input: MetaInteractiveMessage): Promise<SendTemplateMessageResult> {
    const body = await this.post({ to: input.to, type: "interactive", interactive: input.interactive }, "interactive");
    return { providerMessageId: firstMessageId(body), raw: body };
  }

  async sendCatalog(input: MetaCatalogMessage): Promise<SendTemplateMessageResult> {
    const interactive = input.sections
      ? {
          type: "product_list",
          body: { text: input.bodyText ?? "" },
          action: {
            catalog_id: input.catalogId,
            sections: input.sections.map((s) => ({ title: s.title, product_items: s.productRetailerIds.map((id) => ({ product_retailer_id: id })) })),
          },
        }
      : { type: "catalog_message", body: { text: input.bodyText ?? "" }, action: { catalog_id: input.catalogId } };
    const body = await this.post({ to: input.to, type: "interactive", interactive }, "catalog");
    return { providerMessageId: firstMessageId(body), raw: body };
  }

  /** Meta requires this call to mark an inbound message read (drives the customer-visible blue ticks). */
  async markAsRead(providerMessageId: string): Promise<void> {
    await this.post({ status: "read", message_id: providerMessageId }, "mark-as-read");
  }

  verifyWebhook(req: RawWebhookRequest): boolean {
    const header = req.headers["x-hub-signature-256"];
    const value = Array.isArray(header) ? header[0] : header;
    return verifyMetaSignature(req.rawBody, value, this.config.appSecret);
  }

  /** POST /{WABA_ID}/message_templates - confirmed against Meta's current published Message Templates API contract.
   *  Submission success means Meta accepted the template FOR REVIEW, never that it is approved - the returned
   *  status is whatever Meta reports at creation time (normally PENDING), read through the exact same
   *  TEMPLATE_STATUS_MAP listTemplates() already uses, so the two paths can never disagree about what a status
   *  string means. Meta's own duplicate-name rule (a second create for an existing name/language on this WABA is
   *  itself rejected by Meta) is surfaced as a WhatsAppSendError, not invented here. */
  async createTemplate(payload: Record<string, unknown>): Promise<{ providerTemplateId: string; status: Exclude<ProviderTemplateStatus, "UNKNOWN">; rejectedReason: string | null }> {
    const url = `https://graph.facebook.com/${this.config.graphApiVersion}/${this.config.businessAccountId}/message_templates`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.accessToken}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new WhatsAppSendError(this.safe(`Could not reach Meta Cloud API to create the template: ${error instanceof Error ? error.message : String(error)}`));
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || !isObject(body) || typeof body.id !== "string") {
      const reason = isObject(body) && isObject(body.error) && typeof body.error.error_user_msg === "string" ? body.error.error_user_msg : isObject(body) && isObject(body.error) && typeof body.error.message === "string" ? body.error.message : `HTTP ${response.status}`;
      throw new WhatsAppSendError(this.safe(`Meta rejected the template submission: ${reason}`), redactDeep(body, [this.config.accessToken, this.config.appSecret, this.config.verifyToken]));
    }
    const rawStatus = typeof body.status === "string" ? body.status.toLowerCase() : "";
    return {
      providerTemplateId: body.id,
      status: (TEMPLATE_STATUS_MAP[rawStatus] as Exclude<ProviderTemplateStatus, "UNKNOWN"> | undefined) ?? "PENDING", // Meta virtually always returns PENDING on a fresh accept; an unrecognised string is never treated as a silent failure
      rejectedReason: isObject(body.rejected_reason) ? null : typeof body.rejected_reason === "string" ? body.rejected_reason : null,
    };
  }

  async listTemplates(): Promise<TemplateSyncResult> {
    // Meta paginates this list (paging.next). The sync marks any previously-synced template that is ABSENT from the
    // result as removed, so a partial list would wrongly disable real templates - every page is read, and if the page
    // cap is hit with more remaining the call fails instead of returning a partial list.
    const MAX_PAGES = 40;
    let url: string | null = `https://graph.facebook.com/${this.config.graphApiVersion}/${this.config.businessAccountId}/message_templates?limit=100`;
    const data: unknown[] = [];
    for (let page = 0; url; page += 1) {
      if (page >= MAX_PAGES) throw new WhatsAppSendError("Meta returned more template pages than this sync will read - refusing to sync a partial list.");
      let response: Response;
      try {
        response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.config.accessToken}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        throw new WhatsAppSendError(this.safe(`Could not reach Meta Cloud API to list templates: ${error instanceof Error ? error.message : String(error)}`));
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isObject(body) || !Array.isArray(body.data)) {
        throw new WhatsAppSendError(`Meta Cloud API rejected the template list request (HTTP ${response.status})`, redactDeep(body, [this.config.accessToken, this.config.appSecret, this.config.verifyToken]));
      }
      data.push(...body.data);
      const next: unknown = isObject(body.paging) ? body.paging.next : null;
      // Only ever follow a next link that stays on Meta's own Graph host.
      url = typeof next === "string" && next.startsWith("https://graph.facebook.com/") ? next : null;
    }
    const body = { data };

    const templates: NormalizedTemplate[] = [];
    for (const row of body.data) {
      if (!isObject(row) || typeof row.id !== "string" || typeof row.name !== "string") continue;
      const bodyComponent = Array.isArray(row.components) ? row.components.find((c) => isObject(c) && c.type === "BODY") : null;
      templates.push({
        providerTemplateId: row.id,
        externalId: row.id,
        name: row.name,
        category: typeof row.category === "string" ? row.category : null,
        language: typeof row.language === "string" ? row.language : "en",
        body: isObject(bodyComponent) && typeof bodyComponent.text === "string" ? bodyComponent.text : "",
        status: TEMPLATE_STATUS_MAP[typeof row.status === "string" ? row.status.toLowerCase() : ""] ?? "UNKNOWN",
        quality: isObject(row.quality_score) && typeof row.quality_score.score === "string" ? row.quality_score.score : null,
        rejectedReason: typeof row.rejected_reason === "string" ? row.rejected_reason : null,
      });
    }
    return { supported: true, templates };
  }

  /**
   * Downloads a customer's media from the Graph API: step 1 resolves the media id to a short-lived URL (needs the access token), step 2 downloads that URL (needs it too). The token is only
   * ever sent to Meta-owned hosts - a redirect anywhere else is refused - and the size is capped and the checksum Meta reported is verified. Nothing is stored; the caller streams it on.
   */
  async fetchMedia(mediaId: string, options: { maxBytes?: number } = {}): Promise<FetchedMedia> {
    const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
    if (!/^[0-9A-Za-z_-]{1,100}$/.test(mediaId)) throw new WhatsAppMediaError("Invalid media id", "NOT_FOUND");
    const headers = { Authorization: `Bearer ${this.config.accessToken}` };

    let info: Record<string, unknown>;
    try {
      const res = await this.fetchImpl(`https://graph.facebook.com/${this.config.graphApiVersion}/${mediaId}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 404 || res.status === 400) throw new WhatsAppMediaError("The media is no longer available from WhatsApp", "NOT_FOUND");
      if (!res.ok) throw new WhatsAppMediaError(`WhatsApp refused the media lookup (HTTP ${res.status})`, "UNAVAILABLE");
      const body = await res.json().catch(() => null);
      if (!isObject(body)) throw new WhatsAppMediaError("WhatsApp returned an unreadable media description", "UNAVAILABLE");
      info = body;
    } catch (error) {
      if (error instanceof WhatsAppMediaError) throw error;
      logger.error("Meta Cloud API media lookup failed", this.safe(error instanceof Error ? error.message : String(error)));
      throw new WhatsAppMediaError("Could not reach WhatsApp to look the media up", "UNAVAILABLE");
    }

    let url = typeof info.url === "string" ? info.url : "";
    let response: Response | null = null;
    for (let hop = 0; hop < 3; hop += 1) {
      if (!isMetaMediaUrl(url)) throw new WhatsAppMediaError("WhatsApp returned a media address that is not a WhatsApp host; it was not fetched", "UNAVAILABLE");
      try {
        response = await this.fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
      } catch (error) {
        logger.error("Meta Cloud API media download failed", this.safe(error instanceof Error ? error.message : String(error)));
        throw new WhatsAppMediaError("Could not download the media from WhatsApp", "UNAVAILABLE");
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new WhatsAppMediaError("WhatsApp redirected without a location", "UNAVAILABLE");
        url = new URL(location, url).toString();
        response = null;
        continue;
      }
      break;
    }
    if (!response) throw new WhatsAppMediaError("Too many redirects while downloading the media", "UNAVAILABLE");
    if (response.status === 404 || response.status === 410) throw new WhatsAppMediaError("The media is no longer available from WhatsApp", "NOT_FOUND");
    if (!response.ok) throw new WhatsAppMediaError(`WhatsApp refused the media download (HTTP ${response.status})`, "UNAVAILABLE");

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new WhatsAppMediaError("The file is larger than the CRM will serve", "TOO_LARGE");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new WhatsAppMediaError("The file is larger than the CRM will serve", "TOO_LARGE");

    const reported = typeof info.sha256 === "string" ? info.sha256.trim().toLowerCase() : "";
    let verified: boolean | null = null;
    if (reported) {
      verified = createHash("sha256").update(buffer).digest("hex") === reported;
      if (!verified) throw new WhatsAppMediaError("The downloaded file did not match WhatsApp's checksum, so it was not shown", "INTEGRITY");
    }
    return { buffer, mimeType: typeof info.mime_type === "string" ? info.mime_type : null, checksumVerified: verified };
  }

  parseIncomingWebhook(payload: unknown): NormalizedIncomingMessage[] {
    try {
      const values = metaCloudApiMessages(payload);
      const out: NormalizedIncomingMessage[] = [];
      for (const value of values) {
        if (!isObject(value)) continue;
        const businessNumber = isObject(value.metadata) && typeof value.metadata.display_phone_number === "string" ? value.metadata.display_phone_number : null;
        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const m of messages) {
          if (!isObject(m) || typeof m.id !== "string" || typeof m.from !== "string") continue;
          const type = typeof m.type === "string" ? m.type : "unknown";
          const text = type === "text" && isObject(m.text) && typeof m.text.body === "string" ? m.text.body : null;
          const timestampSec = typeof m.timestamp === "string" ? Number(m.timestamp) : NaN;
          // Meta's documented `context` object appears only when the customer tapped "reply" on a
          // specific earlier message: { from, id } - `id` is that message's own wamid. Read only, never
          // synthesized - most inbound messages simply have no `context` at all.
          const replyToProviderMessageId = isObject(m.context) && typeof m.context.id === "string" ? m.context.id : null;
          out.push({
            providerMessageId: m.id,
            from: m.from,
            to: businessNumber,
            messageType: text !== null ? "TEXT" : type === "interactive" ? "INTERACTIVE" : ["image", "video", "audio", "document", "sticker"].includes(type) ? "MEDIA" : "OTHER",
            text,
            // Media id / MIME type / file name / checksum / caption, exactly as Meta sent them (null when the id is missing).
            media: parseMetaMedia(m),
            timestamp: Number.isFinite(timestampSec) ? new Date(timestampSec * 1000) : new Date(),
            replyToProviderMessageId,
          });
        }
      }
      return out;
    } catch (error) {
      logger.error("Meta Cloud API inbound webhook did not match the expected shape", error);
      return [];
    }
  }

  parseDeliveryStatusWebhook(payload: unknown): NormalizedStatusUpdate[] {
    try {
      const values = metaCloudApiMessages(payload);
      const out: NormalizedStatusUpdate[] = [];
      for (const value of values) {
        if (!isObject(value)) continue;
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const s of statuses) {
          if (!isObject(s) || typeof s.id !== "string" || typeof s.status !== "string") continue;
          const status = STATUS_MAP[s.status.toLowerCase()];
          if (!status) continue;
          const timestampSec = typeof s.timestamp === "string" ? Number(s.timestamp) : NaN;
          const errors = Array.isArray(s.errors) ? s.errors : [];
          const firstError = isObject(errors[0]) ? errors[0] : null;
          out.push({
            providerMessageId: s.id,
            status,
            timestamp: Number.isFinite(timestampSec) ? new Date(timestampSec * 1000) : new Date(),
            errorCode: firstError && typeof firstError.code !== "undefined" ? String(firstError.code) : undefined,
            errorMessage: firstError ? this.safe(describeStatusError(firstError)) : undefined,
          });
        }
      }
      return out;
    } catch (error) {
      logger.error("Meta Cloud API status webhook did not match the expected shape", error);
      return [];
    }
  }
}

function firstMessageId(body: Record<string, unknown>): string | null {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = messages[0];
  return isObject(first) && typeof first.id === "string" ? first.id : null;
}

// A delivery-status webhook's per-status error object - Meta's OTHER error shape, distinct from the
// synchronous POST /messages error envelope describeMetaError() below handles. Documented as
// { code, title, message, error_data: { details }, href }. Bug fix: this previously surfaced only
// `title` (e.g. "Business eligibility payment issue") and silently dropped `error_data.details` -
// which is where Meta actually explains WHAT to fix (e.g. "your WhatsApp Business account currency
// is not configured... visit <billing hub URL> to resolve this issue") - and the numeric `code`,
// leaving an admin with an unactionable, unsearchable message. None of these fields are secrets.
function describeStatusError(err: Record<string, unknown>): string {
  const parts: string[] = [];
  const detail = typeof err.title === "string" ? err.title : typeof err.message === "string" ? err.message : null;
  if (detail) parts.push(detail);
  if (isObject(err.error_data) && typeof err.error_data.details === "string" && err.error_data.details !== detail) parts.push(err.error_data.details);
  if (typeof err.code !== "undefined") parts.push(`code ${err.code}`);
  if (typeof err.href === "string") parts.push(err.href);
  return parts.length > 0 ? parts.join(" — ") : "no further detail from Meta";
}

// Meta's documented error envelope: { error: { message, type, code, error_subcode, error_data: { details }, fbtrace_id } }.
// None of these fields are secrets - surfacing them is what turns "HTTP 400" into something an admin can actually act on.
function describeMetaError(parsed: unknown): string {
  if (!isObject(parsed) || !isObject(parsed.error)) return "no further detail from Meta";
  const err = parsed.error;
  const parts: string[] = [];
  if (typeof err.message === "string") parts.push(err.message);
  if (isObject(err.error_data) && typeof err.error_data.details === "string") parts.push(err.error_data.details);
  if (typeof err.code !== "undefined") parts.push(`code ${err.code}`);
  if (typeof err.error_subcode !== "undefined") parts.push(`subcode ${err.error_subcode}`);
  if (typeof err.fbtrace_id === "string") parts.push(`trace ${err.fbtrace_id}`);
  return parts.length > 0 ? parts.join(" — ") : "no further detail from Meta";
}
