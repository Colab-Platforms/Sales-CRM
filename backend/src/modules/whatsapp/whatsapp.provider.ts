// Provider abstraction: the rest of the CRM (service/controller/processor) talks to this interface
// only, never to AiSensy or Gupshup specifics directly. Mirrors how shopify.client.ts isolates the
// rest of the app from the Shopify Admin API's own shapes.

// "META" (the official WhatsApp Cloud API, called directly) is additive: it never flows through
// whatsapp.factory.ts's env-based getWhatsAppProvider() - see whatsapp.meta.factory.ts's separate,
// DB-config-backed loader. Included here only so it can share this type with the generic webhook
// store/handler/processor (whatsapp.webhook.store.ts etc.), which are already fully provider-id-generic.
export type WhatsAppProviderId = "AISENSY" | "GUPSHUP" | "META";

export interface SendTemplateMessageMedia {
  /** Must already be a publicly accessible https URL - never a local filesystem path. The CRM has
   *  no file-hosting/storage service of its own (see whatsapp.messaging.service.ts's
   *  assertValidMediaUrl), so this is always a URL the caller already has, never something the CRM
   *  uploads on their behalf. */
  url: string;
  filename?: string;
}

export interface SendTemplateMessageInput {
  /** Destination WhatsApp number, already normalized (E.164-ish, e.g. "+919876543210"). */
  to: string;
  templateName: string;
  /** Positional template variables, in the order the approved template defines them. */
  params: string[];
  /** Recipient's display name, when known. Some providers (AiSensy) require a name field on every
   *  send; adapters that need one fall back to the phone number rather than inventing a name. */
  contactName?: string;
  /** Optional media attached to this same template send - AiSensy's Campaign API accepts this
   *  alongside campaignName/destination/params in one call (documented `media: { url, filename }`
   *  field), not as a separate free-standing media message. A provider that doesn't support this
   *  (e.g. Gupshup, not yet wired for it) is free to ignore it. */
  media?: SendTemplateMessageMedia;
  /** The template's approved language code (e.g. "en_US", "hi"). Meta requires it to match the approved template;
   *  AiSensy/Gupshup ignore it. */
  languageCode?: string;
}

export interface SendTemplateMessageResult {
  /** The provider's id for this message, when it returns one synchronously. Some BSP "campaign"
   *  style APIs only confirm acceptance, not a per-message id, until a status webhook arrives. */
  providerMessageId: string | null;
  /** Raw provider response, kept only for troubleshooting - never logged with credentials, and
   *  never returned to the frontend as-is. */
  raw: unknown;
}

export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = "WhatsAppSendError";
  }
}

/** One request/response pulled apart to the minimum a provider adapter needs, independent of Express. */
export interface RawWebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
}

export interface NormalizedIncomingMessage {
  providerMessageId: string;
  /** Customer's WhatsApp number, exactly as the provider sent it (not yet normalized). */
  from: string;
  to: string | null;
  messageType: "TEXT" | "MEDIA" | "INTERACTIVE" | "OTHER";
  /** Message text, when the provider payload has one and the type is TEXT. Never fabricated for a
   *  non-text message. */
  text: string | null;
  timestamp: Date;
}

export type WhatsAppDeliveryStatus = "SENT" | "DELIVERED" | "READ" | "FAILED";

export interface NormalizedStatusUpdate {
  providerMessageId: string;
  status: WhatsAppDeliveryStatus;
  timestamp: Date;
  errorCode?: string;
  errorMessage?: string;
}

// E7.2 Template Management. A provider template's status in the provider's own review process -
// not the CRM's WhatsAppTemplateStatus enum directly, though the sync service maps 1:1 onto it.
export type ProviderTemplateStatus = "APPROVED" | "PENDING" | "REJECTED" | "DISABLED" | "UNKNOWN";

export interface NormalizedTemplate {
  providerTemplateId: string;
  externalId: string | null;
  name: string;
  category: string | null;
  language: string;
  /** The provider's own body text, kept only for display/audit - never trusted for {{variable}} parsing (E7.3 maps names separately). */
  body: string;
  status: ProviderTemplateStatus;
  quality: string | null;
}

/**
 * Whether this provider's API can list/fetch its own templates right now. `false` covers two
 * distinct, both-honest cases: the provider has no such API at all (AiSensy's Campaign API), or it
 * does but the CRM is not configured for it (Gupshup's Partner API needs its own credentials,
 * separate from the ones used to send messages) - `reason` says which.
 */
export type TemplateSyncResult = { supported: true; templates: NormalizedTemplate[] } | { supported: false; reason: string };

export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId;

  sendTemplateMessage(input: SendTemplateMessageInput): Promise<SendTemplateMessageResult>;

  /** Fetches this provider's current templates, or reports why it can't (see TemplateSyncResult). Never throws for an unsupported/unconfigured provider - only for a real transport failure once support is confirmed. */
  listTemplates(): Promise<TemplateSyncResult>;

  /** Authenticates one webhook delivery against this provider's supported mechanism. Must not throw
   *  on a malformed request - false means "reject", same as an invalid signature. */
  verifyWebhook(req: RawWebhookRequest): boolean;

  /** Every inbound customer message found in one delivery (a delivery can batch more than one).
   *  Returns [] - never throws - for a payload shape the parser does not recognise; the raw
   *  payload is still kept by the caller in the webhook_events row for later inspection. */
  parseIncomingWebhook(payload: unknown): NormalizedIncomingMessage[];

  /** Every delivery/read/failed status update found in one delivery. Same never-throws contract. */
  parseDeliveryStatusWebhook(payload: unknown): NormalizedStatusUpdate[];
}
