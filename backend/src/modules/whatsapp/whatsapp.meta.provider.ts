import { logger } from "@/utils/logger.js";
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

export class MetaCloudApiProvider implements WhatsAppProvider {
  readonly id = "META" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: MetaCloudApiCredentials,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private messagesUrl(): string {
    return `https://graph.facebook.com/${this.config.graphApiVersion}/${this.config.phoneNumberId}/messages`;
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
        logger.error(`Meta Cloud API ${label} send failed to reach Graph API`, error instanceof Error ? error.message : error);
        continue; // network failure - retry once
      }

      const parsed = await response.json().catch(() => null);
      if (response.ok) return isObject(parsed) ? parsed : {};

      if (RETRYABLE_STATUS.has(response.status) && attempt === 0) {
        lastError = parsed;
        continue; // rate-limited/transient - retry once
      }
      throw new WhatsAppSendError(`Meta Cloud API rejected the ${label} message (HTTP ${response.status})`, parsed);
    }
    throw new WhatsAppSendError(`Could not reach Meta Cloud API for ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`, lastError);
  }

  async sendTemplateMessage(input: SendTemplateMessageInput): Promise<SendTemplateMessageResult> {
    const components = input.params.length > 0 ? [{ type: "body", parameters: input.params.map((text) => ({ type: "text", text })) }] : [];
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
    const body = await this.post({ to: input.to, type: "text", text: { body: input.body, preview_url: input.previewUrl ?? false } }, "text");
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

  async listTemplates(): Promise<TemplateSyncResult> {
    const url = `https://graph.facebook.com/${this.config.graphApiVersion}/${this.config.businessAccountId}/message_templates`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new WhatsAppSendError(`Could not reach Meta Cloud API to list templates: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || !isObject(body) || !Array.isArray(body.data)) {
      throw new WhatsAppSendError(`Meta Cloud API rejected the template list request (HTTP ${response.status})`, body);
    }

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
      });
    }
    return { supported: true, templates };
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
          out.push({
            providerMessageId: m.id,
            from: m.from,
            to: businessNumber,
            messageType: text !== null ? "TEXT" : type === "interactive" ? "INTERACTIVE" : ["image", "video", "audio", "document", "sticker"].includes(type) ? "MEDIA" : "OTHER",
            text,
            timestamp: Number.isFinite(timestampSec) ? new Date(timestampSec * 1000) : new Date(),
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
            errorMessage: firstError && typeof firstError.title === "string" ? firstError.title : undefined,
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
