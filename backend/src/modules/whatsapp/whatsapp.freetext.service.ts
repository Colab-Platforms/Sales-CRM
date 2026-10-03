import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { WhatsAppProviderName } from "../../../generated/prisma/client.js";
import { getMetaWhatsAppProvider } from "./whatsapp.meta.factory.js";
import type { MetaCloudApiProvider } from "./whatsapp.meta.provider.js";
import { findConversationProvider } from "./whatsapp.conversation-provider.js";

// Meta's customer-service window: free-form (non-template) messages may only be sent for 24 hours after the
// customer's last inbound message TO THE SAME business number. An AiSensy/Gupshup inbound opens no window on the
// Meta number, so only inbound messages received through META count here.
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const PROVIDER_DISPLAY_NAMES: Record<WhatsAppProviderName, string> = { META: "Meta Cloud API", AISENSY: "AiSensy", GUPSHUP: "Gupshup" };

export type FreeTextBlockReason = "PROVIDER_NOT_META" | "META_NOT_CONFIGURED" | "SERVICE_WINDOW_CLOSED";

export interface MessagingCapability {
  /** The provider this conversation is on: the one its customer last messaged through (or, with no history, Meta when configured). */
  activeProvider: WhatsAppProviderName | null;
  activeProviderLabel: string | null;
  freeText: { allowed: boolean; reason: FreeTextBlockReason | null; message: string | null };
  serviceWindow: { open: boolean; lastInboundAt: string | null; expiresAt: string | null };
}

export function computeServiceWindow(lastInboundAt: Date | null, now: Date): MessagingCapability["serviceWindow"] {
  if (!lastInboundAt) return { open: false, lastInboundAt: null, expiresAt: null };
  const expires = new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS);
  return { open: expires.getTime() > now.getTime(), lastInboundAt: lastInboundAt.toISOString(), expiresAt: expires.toISOString() };
}

// Never names a provider - Meta Cloud API is the CRM's only active WhatsApp provider from the
// user's point of view, so a message like "this conversation's active provider is AiSensy" would be
// both confusing (the CRM shows no AiSensy option anywhere) and misleading (implies a per-provider
// restriction rather than "free text isn't available for this conversation yet").
const BLOCK_MESSAGES = (_provider: WhatsAppProviderName | null, hadInbound: boolean): Record<FreeTextBlockReason, string> => ({
  PROVIDER_NOT_META: "Free-text messages are not available for this conversation yet. Use a template message instead.",
  META_NOT_CONFIGURED: "Meta WhatsApp Cloud API is not configured (or its saved credentials cannot be decrypted). Check Settings → WhatsApp Config.",
  SERVICE_WINDOW_CLOSED: hadInbound
    ? "The 24-hour WhatsApp customer-service window has closed - this customer's last message to your Meta number was more than 24 hours ago. Send an approved template message instead."
    : "The WhatsApp customer-service window is not open - this customer has not messaged your Meta number in the last 24 hours. Send an approved template message instead.",
});

class WhatsAppFreeTextService {
  // getMeta and now are injectable so the provider/window rules are testable without Meta or a database.
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getMeta: () => Promise<MetaCloudApiProvider | null> = () => getMetaWhatsAppProvider(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async resolveActiveProvider(leadId: string, metaConfigured: boolean): Promise<WhatsAppProviderName | null> {
    const { provider } = await findConversationProvider(this.db, leadId);
    if (provider) return provider;
    // No history at all: a Meta-configured workspace starts on Meta rather than inheriting a legacy default.
    return metaConfigured ? "META" : null;
  }

  async getCapability(leadId: string): Promise<{ capability: MessagingCapability; meta: MetaCloudApiProvider | null }> {
    const meta = await this.getMeta();
    const activeProvider = await this.resolveActiveProvider(leadId, meta !== null);

    const lastMetaInbound = await this.db.whatsAppMessage.findFirst({
      where: { leadId, provider: "META", direction: "INBOUND" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { receivedAt: true, createdAt: true },
    });
    const serviceWindow = computeServiceWindow(lastMetaInbound ? (lastMetaInbound.receivedAt ?? lastMetaInbound.createdAt) : null, this.now());

    let reason: FreeTextBlockReason | null = null;
    if (activeProvider !== "META") reason = "PROVIDER_NOT_META";
    else if (!meta) reason = "META_NOT_CONFIGURED";
    else if (!serviceWindow.open) reason = "SERVICE_WINDOW_CLOSED";

    return {
      meta,
      capability: {
        activeProvider,
        activeProviderLabel: activeProvider ? PROVIDER_DISPLAY_NAMES[activeProvider] : null,
        freeText: { allowed: reason === null, reason, message: reason ? BLOCK_MESSAGES(activeProvider, serviceWindow.lastInboundAt !== null)[reason] : null },
        serviceWindow,
      },
    };
  }

  /** Sends a free-text message through Meta - only when the conversation's active provider is META, Meta is
   *  configured, and the 24-hour service window is open. Otherwise refuses (400) and sends nothing. */
  async sendText(
    lead: { id: string; normalizedMobile: string },
    text: string,
    sentById: string,
    orderId?: string,
    /** The wamid (providerMessageId) of the message this one quotes as a reply - real Meta
     *  `context.message_id` capability, not a CRM-only visual approximation. */
    replyToProviderMessageId?: string,
  ): Promise<{ id: string }> {
    const { capability, meta } = await this.getCapability(lead.id);
    if (!capability.freeText.allowed || !meta) throw new ApiError(capability.freeText.message ?? "Free-text messages cannot be sent for this conversation.", STATUS_CODES.BAD_REQUEST);

    const result = await meta.sendText({ to: lead.normalizedMobile, body: text, ...(replyToProviderMessageId ? { replyToMessageId: replyToProviderMessageId } : {}) });
    return this.db.whatsAppMessage.create({
      data: {
        provider: "META",
        providerMessageId: result.providerMessageId,
        replyToProviderMessageId: replyToProviderMessageId ?? null,
        direction: "OUTBOUND",
        messageType: "TEXT",
        status: result.providerMessageId ? "SENT" : "QUEUED",
        leadId: lead.id,
        orderId: orderId ?? null,
        toNumber: lead.normalizedMobile,
        normalizedContact: lead.normalizedMobile,
        body: text,
        sentById,
        sentAt: this.now(),
      },
      select: { id: true },
    });
  }
}

export default WhatsAppFreeTextService;
