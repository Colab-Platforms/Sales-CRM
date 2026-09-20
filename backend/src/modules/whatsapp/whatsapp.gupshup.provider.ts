import { logger } from "@/utils/logger.js";
import type { GupshupConfig } from "./whatsapp.config.js";
import { verifyGupshupToken } from "./whatsapp.hmac.js";
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

// Gupshup WhatsApp API: confirmed against Gupshup's published API reference.
//   POST https://api.gupshup.io/wa/api/v1/template/msg
//   header: apikey: <key>, Content-Type: application/x-www-form-urlencoded
//   body:   channel=whatsapp&source=<businessNumber>&destination=<to>&src.name=<appName>
//           &template={"id":"<templateId>","params":[...]}
// "template.id" here is Gupshup's approved template id, not a human-readable name; the CRM passes
// whatever templateName the caller gives it straight through, so template setup on the Gupshup
// side must use the same value as its id (documented in whatsapp module README-equivalent comment
// rather than invented UI, since E7.1 has no template-management screen).
const SEND_URL = "https://api.gupshup.io/wa/api/v1/template/msg";

// Gupshup's separate Partner API (confirmed against Gupshup's published Partner API reference),
// needed only for template sync:
//   1. POST https://partner.gupshup.io/partner/account/login  (form: email, password) -> { token }
//   2. GET  https://partner.gupshup.io/partner/app/{appId}/token  (Authorization: partner token) -> { token: { token } }
//   3. GET  https://partner.gupshup.io/partner/app/{appId}/templates  (Authorization: app token) -> { templates: [...] }
// This uses a *different* credential (GUPSHUP_PARTNER_EMAIL/PASSWORD + GUPSHUP_APP_ID) than the
// simple apikey used above for sending, which is why it is gated on its own optional config rather
// than the base Gupshup config - a store can send messages long before anyone sets these up.
const PARTNER_LOGIN_URL = "https://partner.gupshup.io/partner/account/login";
const partnerAppTokenUrl = (appId: string) => `https://partner.gupshup.io/partner/app/${appId}/token`;
const partnerTemplatesUrl = (appId: string) => `https://partner.gupshup.io/partner/app/${appId}/templates`;

// Confirmed against Gupshup's Get Templates reference: status values include APPROVED/REJECTED and
// others (PENDING and provider-side "paused"/disabled-like states); anything not explicitly one of
// the CRM's own four is mapped to DISABLED rather than guessed at, since an unrecognised status must
// never be treated as usable for sending.
const TEMPLATE_STATUS_MAP: Record<string, ProviderTemplateStatus> = {
  approved: "APPROVED",
  pending: "PENDING",
  rejected: "REJECTED",
};

const header = (headers: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// Confirmed against Gupshup's "message-event" webhook envelope: {app, timestamp, version,
// type: "message-event", payload: {id, gsId, type: enqueued|failed|sent|delivered|read|deleted,
// destination, payload: {...}}}.
const STATUS_MAP: Record<string, WhatsAppDeliveryStatus> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

export class GupshupProvider implements WhatsAppProvider {
  readonly id = "GUPSHUP" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: GupshupConfig,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendTemplateMessage(input: SendTemplateMessageInput): Promise<SendTemplateMessageResult> {
    const form = new URLSearchParams({
      channel: "whatsapp",
      source: this.config.sourceNumber,
      destination: input.to,
      "src.name": this.config.appName,
      template: JSON.stringify({ id: input.templateName, params: input.params }),
    });

    let response: Response;
    try {
      response = await this.fetchImpl(SEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", apikey: this.config.apiKey },
        body: form,
      });
    } catch (error) {
      throw new WhatsAppSendError(`Could not reach Gupshup: ${error instanceof Error ? error.message : String(error)}`);
    }

    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Gupshup's success response is not guaranteed to be JSON; the raw text is kept as-is.
    }

    if (!response.ok) {
      throw new WhatsAppSendError(`Gupshup rejected the message (HTTP ${response.status})`, parsed);
    }

    // Gupshup's send response carries the Gupshup message id as messageId (confirmed shape: a
    // top-level "status" plus "messageId" on success); a different or missing field just means no
    // id is known yet, which the webhook's providerMessageId will supply once a status event arrives.
    const providerMessageId = isObject(parsed) && typeof parsed.messageId === "string" ? parsed.messageId : null;
    return { providerMessageId, raw: parsed };
  }

  verifyWebhook(req: RawWebhookRequest): boolean {
    // Gupshup authenticates callbacks with a system-generated Authorization token set alongside
    // the webhook URL in the Gupshup dashboard, not a per-request HMAC signature.
    return verifyGupshupToken(header(req.headers, "authorization"), this.config.webhookToken);
  }

  async listTemplates(): Promise<TemplateSyncResult> {
    const sync = this.config.templateSync;
    if (!sync) {
      return {
        supported: false,
        reason: "Gupshup template sync needs its own Partner API credentials (GUPSHUP_APP_ID, GUPSHUP_PARTNER_EMAIL, GUPSHUP_PARTNER_PASSWORD), which are not configured. Sending messages does not require these.",
      };
    }

    try {
      const partnerToken = await this.partnerLogin(sync.partnerEmail, sync.partnerPassword);
      const appToken = await this.partnerAppToken(sync.appId, partnerToken);
      const templates = await this.fetchTemplates(sync.appId, appToken);
      return { supported: true, templates };
    } catch (error) {
      // A real transport/auth failure once support is confirmed - not the same as "not configured".
      throw error instanceof WhatsAppSendError ? error : new WhatsAppSendError(`Gupshup template sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async partnerLogin(email: string, password: string): Promise<string> {
    const form = new URLSearchParams({ email, password });
    const res = await this.fetchImpl(PARTNER_LOGIN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    const body = await res.json().catch(() => null);
    if (!res.ok || !isObject(body) || typeof body.token !== "string") {
      throw new WhatsAppSendError(`Gupshup partner login failed (HTTP ${res.status})`, body);
    }
    return body.token;
  }

  private async partnerAppToken(appId: string, partnerToken: string): Promise<string> {
    const res = await this.fetchImpl(partnerAppTokenUrl(appId), { headers: { Authorization: partnerToken } });
    const body = await res.json().catch(() => null);
    const token = isObject(body) && isObject(body.token) ? body.token.token : undefined;
    if (!res.ok || typeof token !== "string") {
      throw new WhatsAppSendError(`Could not get a Gupshup app access token (HTTP ${res.status})`, body);
    }
    return token;
  }

  private async fetchTemplates(appId: string, appToken: string): Promise<NormalizedTemplate[]> {
    const res = await this.fetchImpl(partnerTemplatesUrl(appId), { headers: { Authorization: appToken } });
    const body = await res.json().catch(() => null);
    if (!res.ok || !isObject(body) || !Array.isArray(body.templates)) {
      throw new WhatsAppSendError(`Could not list Gupshup templates (HTTP ${res.status})`, body);
    }

    const templates: NormalizedTemplate[] = [];
    for (const row of body.templates) {
      if (!isObject(row) || typeof row.id !== "string" || typeof row.elementName !== "string") continue; // an unrecognised row is skipped, not guessed at
      templates.push({
        providerTemplateId: row.id,
        externalId: typeof row.externalId === "string" ? row.externalId : null,
        name: row.elementName,
        category: typeof row.category === "string" ? row.category : null,
        language: typeof row.languageCode === "string" ? row.languageCode : "en",
        body: typeof row.data === "string" ? row.data : "",
        status: TEMPLATE_STATUS_MAP[typeof row.status === "string" ? row.status.toLowerCase() : ""] ?? "DISABLED",
        quality: typeof row.quality === "string" ? row.quality : null,
      });
    }
    return templates;
  }

  parseIncomingWebhook(payload: unknown): NormalizedIncomingMessage[] {
    try {
      if (!isObject(payload) || payload.type !== "message" || !isObject(payload.payload)) return [];
      const p = payload.payload;
      const id = typeof p.id === "string" ? p.id : null;
      const from = typeof p.source === "string" ? p.source : typeof p.sender === "object" && isObject(p.sender) && typeof p.sender.phone === "string" ? p.sender.phone : null;
      if (!id || !from) return [];

      const type = typeof p.type === "string" ? p.type : "unknown";
      const inner = isObject(p.payload) ? p.payload : {};
      const text = type === "text" && typeof inner.text === "string" ? inner.text : null;
      const timestampMs = typeof payload.timestamp === "number" ? payload.timestamp : Date.now();

      return [
        {
          providerMessageId: id,
          from,
          to: null,
          messageType: text !== null ? "TEXT" : ["image", "video", "audio", "file", "sticker"].includes(type) ? "MEDIA" : type === "button" || type === "list" || type === "quick_reply" ? "INTERACTIVE" : "OTHER",
          text,
          timestamp: new Date(timestampMs),
        },
      ];
    } catch (error) {
      logger.error("Gupshup inbound webhook did not match the expected shape", error);
      return [];
    }
  }

  parseDeliveryStatusWebhook(payload: unknown): NormalizedStatusUpdate[] {
    try {
      if (!isObject(payload) || payload.type !== "message-event" || !isObject(payload.payload)) return [];
      const p = payload.payload;
      // "id" is the Gupshup/WhatsApp message id the send response returned; gsId is Gupshup's own
      // internal id for the delivery record - id is what we stored as providerMessageId on send.
      const id = typeof p.id === "string" ? p.id : typeof p.gsId === "string" ? p.gsId : null;
      const eventType = typeof p.type === "string" ? p.type.toLowerCase() : null;
      if (!id || !eventType) return [];
      const status = STATUS_MAP[eventType];
      if (!status) return []; // "enqueued"/"deleted" are not part of our smaller status set

      const timestampMs = typeof payload.timestamp === "number" ? payload.timestamp : Date.now();
      const inner = isObject(p.payload) ? p.payload : {};
      return [
        {
          providerMessageId: id,
          status,
          timestamp: new Date(timestampMs),
          errorCode: typeof inner.code !== "undefined" ? String(inner.code) : undefined,
          errorMessage: typeof inner.reason === "string" ? inner.reason : undefined,
        },
      ];
    } catch (error) {
      logger.error("Gupshup status webhook did not match the expected shape", error);
      return [];
    }
  }
}
