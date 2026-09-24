import { logger } from "@/utils/logger.js";
import type { AiSensyConfig } from "./whatsapp.config.js";
import { verifyAiSensyHmac } from "./whatsapp.hmac.js";
import { isObject, metaCloudApiMessages } from "./whatsapp.meta.envelope.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type {
  NormalizedIncomingMessage,
  NormalizedStatusUpdate,
  RawWebhookRequest,
  SendTemplateMessageInput,
  SendTemplateMessageResult,
  TemplateSyncResult,
  WhatsAppDeliveryStatus,
  WhatsAppProvider,
} from "./whatsapp.provider.js";

// AiSensy Campaign API: sends a pre-approved template via a named Campaign. Confirmed against
// AiSensy's published API reference (POST https://backend.aisensy.com/campaign/t1/api/v2, JSON
// body with apiKey/campaignName/destination/userName/templateParams; HTTP 200 on acceptance).
const CAMPAIGN_API_URL = "https://backend.aisensy.com/campaign/t1/api/v2";
const SIGNATURE_HEADER = "x-aisensy-signature";

const header = (headers: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

// AiSensy's documented status values (delivered/read/failed/sent) map onto our own enum 1:1.
const STATUS_MAP: Record<string, WhatsAppDeliveryStatus> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

// AiSensy's "Direct API" line proxies Meta's own WhatsApp Cloud API, so its webhook envelope
// (entry[].changes[].value.messages[]/statuses[]) is the same stable, publicly documented format
// the real Meta Cloud API uses (see whatsapp.meta.envelope.ts, shared with whatsapp.meta.provider.ts).
// Not confirmed against a live AiSensy sandbox delivery for this account - an unrecognised shape
// returns [] rather than guessing or throwing.

export class AiSensyProvider implements WhatsAppProvider {
  readonly id = "AISENSY" as const;
  private readonly fetchImpl: typeof fetch;

  // fetchImpl is injectable for tests, same convention as shopify.client.ts's ShopifyClient.
  constructor(
    private readonly config: AiSensyConfig,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendTemplateMessage(input: SendTemplateMessageInput): Promise<SendTemplateMessageResult> {
    const body = {
      apiKey: this.config.apiKey,
      campaignName: input.templateName,
      destination: input.to,
      userName: input.contactName?.trim() || input.to,
      templateParams: input.params,
      // Documented, optional field on the same Campaign API call - only included when the caller
      // actually attached media; omitted entirely otherwise so the existing template-only payload
      // this integration already sends successfully is completely unchanged.
      ...(input.media ? { media: { url: input.media.url, filename: input.media.filename } } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(CAMPAIGN_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new WhatsAppSendError(`Could not reach AiSensy: ${error instanceof Error ? error.message : String(error)}`);
    }

    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // AiSensy's success response is not guaranteed to be JSON; the raw text is kept as-is.
    }

    if (!response.ok) {
      throw new WhatsAppSendError(`AiSensy rejected the message (HTTP ${response.status})`, parsed);
    }

    // CONFIRMED via a real send (see whatsapp.aisensy.webhook.events.ts's header comment): the
    // response's own `id` field is not present/usable in practice - `submitted_message_id` is what
    // actually correlates this send with its later message.status.updated webhooks (that field is
    // identical across a message's whole real lifecycle; `messageId` itself is NOT - it starts as an
    // AiSensy-internal id at creation and only becomes a real wamid once WhatsApp delivers it, so it
    // can never be captured correctly at send time). `id` is kept only as a fallback in case some
    // response shape genuinely uses it - never assumed, always still an exact value, never guessed.
    const providerMessageId = isObject(parsed) && typeof parsed.submitted_message_id === "string" ? parsed.submitted_message_id : isObject(parsed) && typeof parsed.id === "string" ? parsed.id : null;
    return { providerMessageId, raw: parsed };
  }

  verifyWebhook(req: RawWebhookRequest): boolean {
    return verifyAiSensyHmac(req.rawBody, header(req.headers, SIGNATURE_HEADER), this.config.webhookSecret);
  }

  // AiSensy's Campaign API (the product this adapter integrates with) has no documented public
  // endpoint for listing templates or their approval status - template management is dashboard-only
  // there. Represented honestly as unsupported rather than guessed at or faked.
  async listTemplates(): Promise<TemplateSyncResult> {
    return { supported: false, reason: "AiSensy's Campaign API does not provide an endpoint to list templates. Manage templates in the AiSensy dashboard; add them here as local drafts if you want the CRM to track them." };
  }

  parseIncomingWebhook(payload: unknown): NormalizedIncomingMessage[] {
    try {
      const values = metaCloudApiMessages(payload);
      const out: NormalizedIncomingMessage[] = [];
      for (const value of values) {
        if (!isObject(value)) continue;
        const businessNumber =
          isObject(value.metadata) && typeof value.metadata.display_phone_number === "string" ? value.metadata.display_phone_number : null;
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
      logger.error("AiSensy inbound webhook did not match a recognised shape", error);
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
      logger.error("AiSensy status webhook did not match a recognised shape", error);
      return [];
    }
  }
}
