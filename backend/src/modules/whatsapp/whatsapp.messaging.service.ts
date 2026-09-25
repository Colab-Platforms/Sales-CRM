import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { fullName, scopedOrderWhere } from "../orders/orders.filters.js";
import { scopedLeadWhere } from "../customers/customers.filters.js";
import { getWhatsAppProvider } from "./whatsapp.factory.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";
import { getMetaWhatsAppProvider } from "./whatsapp.meta.factory.js";
import { findConversationProvider } from "./whatsapp.conversation-provider.js";
import { PROVIDER_DISPLAY_NAMES } from "./whatsapp.freetext.service.js";
import { renderTemplateBody } from "./whatsapp.template.variables.js";
import type { OrderConfirmationTestResult, PreviewTemplateInput, SendOrderConfirmationTestInput, SendTemplateInput, TemplatePreviewResult } from "./whatsapp.messaging.types.js";
import { resolveTemplateVariables, type VariableResolutionContext } from "./whatsapp.variable-resolver.js";
import type { WhatsAppMessageSummary } from "./whatsapp.types.js";

const MESSAGE_SELECT = {
  id: true,
  provider: true,
  direction: true,
  messageType: true,
  status: true,
  providerMessageId: true,
  templateName: true,
  templateId: true,
  orderId: true,
  body: true,
  errorMessage: true,
  createdAt: true,
  sentAt: true,
  deliveredAt: true,
  readAt: true,
  failedAt: true,
  receivedAt: true,
} satisfies Prisma.WhatsAppMessageSelect;

function mapMessage(row: Prisma.WhatsAppMessageGetPayload<{ select: typeof MESSAGE_SELECT }>): WhatsAppMessageSummary {
  return { ...row };
}

const LEAD_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  mobile: true,
  normalizedMobile: true,
  email: true,
} satisfies Prisma.LeadSelect;

// Only what resolveTemplateVariables actually needs - never the order's full item list or every
// payment field, so a send never pulls more than one small, targeted read per customer/order.
const ORDER_SELECT = {
  id: true,
  leadId: true,
  orderNumber: true,
  externalNumber: true,
  status: true,
  currency: true,
  totalAmount: true,
  payments: { select: { status: true, method: true, amount: true, refundedAmount: true, paymentUrl: true, paymentExpiresAt: true }, orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }] },
  shipments: {
    select: { status: true, courier: true, trackingNumber: true, trackingUrl: true, shippedAt: true, deliveredAt: true, expectedDeliveryAt: true },
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    take: 1,
  },
} satisfies Prisma.OrderSelect;

type LeadRow = Prisma.LeadGetPayload<{ select: typeof LEAD_SELECT }>;
type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;
type TemplateRow = { id: string; name: string; provider: string; providerTemplateId: string | null; language: string; body: string; variables: Prisma.JsonValue; status: string };

const TEMPLATE_SELECT = { id: true, name: true, provider: true, providerTemplateId: true, language: true, body: true, variables: true, status: true } satisfies Prisma.WhatsAppTemplateSelect;

const TEMPLATE_STATUS_MESSAGES: Record<string, string> = {
  DRAFT: "This template is still a draft and has not been approved for sending.",
  PENDING: "This template is pending provider approval and cannot be sent yet.",
  REJECTED: "This template was rejected by the provider and cannot be sent.",
  DISABLED: "This template has been disabled and cannot be sent.",
};

const REFERENCE_TYPE = "WhatsAppMessage";
// "Same customer + same template + same order context, within a very short interval" (E7.3 spec):
// long enough to absorb a double-click or a resubmitted form, short enough that a genuine second
// message to the same customer minutes later is never silently swallowed.
const DUPLICATE_GUARD_MS = 30_000;

// The CRM's own local WhatsAppTemplate.name an admin must use when creating the order-confirmation
// template (POST /api/whatsapp/templates, provider AISENSY) for sendOrderConfirmationTest to find
// it. Not read from an env var: a campaign name is a per-template concept here (AiSensyProvider
// sends `template.providerTemplateId ?? template.name` as AiSensy's own `campaignName` - see
// whatsapp.aisensy.provider.ts), which already generalises to every future template/campaign
// without more config, so a single global AISENSY_API_CAMPAIGN_NAME variable would only narrow that.
// This constant exists solely so this one file and the AiSensy dashboard's Campaign name agree.
export const ORDER_CONFIRMATION_TEMPLATE_NAME = "crm_order_confirmation";

// The CRM has no file-hosting/storage service of its own, and is never allowed to invent one just
// for this - so a media send only ever forwards a URL the caller already has. This is the one place
// that URL is actually checked, so "a local filesystem path" or anything not genuinely publicly
// reachable can never reach AiSensy. Deliberately a plain format/host check, not a network probe
// (this module must never call out to a caller-supplied host itself, which would be its own SSRF risk).
export function assertValidMediaUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError("mediaUrl must be a valid absolute URL (e.g. https://cdn.example.com/file.jpg)", STATUS_CODES.BAD_REQUEST);
  }
  if (parsed.protocol !== "https:") {
    throw new ApiError("mediaUrl must use https - AiSensy requires a publicly accessible URL", STATUS_CODES.BAD_REQUEST);
  }
  const host = parsed.hostname.toLowerCase();
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "127.0.0.1" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (isPrivate) {
    throw new ApiError("mediaUrl must be a publicly accessible address, not a local/private host", STATUS_CODES.BAD_REQUEST);
  }
}

/** Never the raw number - e.g. "+919876543210" -> "********3210". */
function maskDestination(mobile: string | null): string {
  if (!mobile) return "-";
  const digits = mobile.replace(/\D/g, "");
  if (digits.length <= 4) return "*".repeat(digits.length);
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

// Who is asking for this send. A real signed-in user is subject to E7.1's lead-scope RBAC (the same
// rule Customer 360's "Send WhatsApp" button always has); E7.6's lifecycle automation is a system
// process reacting to a real business event it already resolved the correct lead/order for directly
// (the same trust level shopify.persist.ts's own writes already operate at) - not a human trying to
// reach a customer, so there is no per-user scope to check. Either way the resulting WhatsAppMessage/
// Activity honestly records who/what actually sent it (sentById + ActivitySource) - never attributed
// to a fabricated user.
type SendActor = { kind: "user"; user: AuthUser } | { kind: "system" };

class WhatsAppMessagingService {
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getProvider: () => WhatsAppProvider | null = getWhatsAppProvider,
    // Meta's provider is DB-config-backed (Settings -> WhatsApp Config), not env-based like getProvider, so it is looked
    // up separately - and only when a conversation is actually on Meta. Injectable for tests.
    private readonly getMeta?: () => Promise<WhatsAppProvider | null>,
  ) {}

  private metaProvider(): Promise<WhatsAppProvider | null> {
    return this.getMeta ? this.getMeta() : getMetaWhatsAppProvider(this.db);
  }

  /** Which provider a template send goes through.
   *  - System senders (lifecycle automation, campaigns): the legacy env-configured provider, exactly as before.
   *  - A signed-in user: the provider the lead's conversation is on (same resolver the free-text capability uses),
   *    never overridden by the global WHATSAPP_PROVIDER. META -> the active Meta config; AISENSY/GUPSHUP -> the
   *    legacy provider, but only if it really is that provider (never silently sent through the other one).
   *  - A lead with no WhatsApp history at all: the legacy provider if configured (unchanged behavior), else Meta. */
  private async resolveSendProvider(actor: SendActor, leadId: string): Promise<{ provider: WhatsAppProvider; fromConversation: boolean }> {
    const legacy = this.getProvider();
    if (actor.kind === "system") {
      if (!legacy) throw new ApiError("WhatsApp is not configured", STATUS_CODES.SERVICE_UNAVAILABLE);
      return { provider: legacy, fromConversation: false };
    }

    const { provider: conversationProvider } = await findConversationProvider(this.db, leadId);

    if (conversationProvider === "META") {
      const meta = await this.metaProvider();
      if (!meta) throw new ApiError("This conversation is on Meta Cloud API, but Meta WhatsApp Cloud API is not configured (or its saved credentials cannot be decrypted). Check Settings → WhatsApp Config.", STATUS_CODES.SERVICE_UNAVAILABLE);
      return { provider: meta, fromConversation: true };
    }

    if (conversationProvider) {
      if (!legacy) throw new ApiError("WhatsApp is not configured", STATUS_CODES.SERVICE_UNAVAILABLE);
      if (legacy.id !== conversationProvider) {
        throw new ApiError(`This conversation is on ${PROVIDER_DISPLAY_NAMES[conversationProvider]}, but ${PROVIDER_DISPLAY_NAMES[conversationProvider]} is not the configured provider (${PROVIDER_DISPLAY_NAMES[legacy.id]} is), so a template cannot be sent from here.`, STATUS_CODES.BAD_REQUEST);
      }
      return { provider: legacy, fromConversation: true };
    }

    if (legacy) return { provider: legacy, fromConversation: false };
    const meta = await this.metaProvider();
    if (meta) return { provider: meta, fromConversation: false };
    throw new ApiError("WhatsApp is not configured", STATUS_CODES.SERVICE_UNAVAILABLE);
  }

  /** Which provider a template sent by this user to this lead would go through - the same resolution send() uses -
   *  or, when it cannot be sent, why. Never throws for a not-configured/mismatched provider; powers the Send Template dialog. */
  async describeTemplateProvider(user: AuthUser, leadId: string): Promise<{ provider: WhatsAppProvider["id"] | null; message: string | null }> {
    try {
      const { provider } = await this.resolveSendProvider({ kind: "user", user }, leadId);
      return { provider: provider.id, message: null };
    } catch (error) {
      if (error instanceof ApiError) return { provider: null, message: error.message };
      throw error;
    }
  }

  async previewTemplate(user: AuthUser, input: PreviewTemplateInput): Promise<TemplatePreviewResult> {
    const { template, resolution } = await this.loadAndResolve({ kind: "user", user }, input, { requireProviderMatch: false });
    if (resolution.errors.length > 0) throw new ApiError(resolution.errors[0], STATUS_CODES.BAD_REQUEST);

    return {
      templateId: template.id,
      templateName: template.name,
      provider: template.provider,
      language: template.language,
      resolvedBody: renderTemplateBody(template.body, resolution.values),
      variables: resolution.values,
    };
  }

  async sendTemplate(user: AuthUser, input: SendTemplateInput): Promise<WhatsAppMessageSummary> {
    return this.send({ kind: "user", user }, input);
  }

  // E7.6/E7.7: the same send path a user's "Send WhatsApp" button uses, minus the per-user
  // lead-scope check - see the SendActor comment above for why. Every other rule (APPROVED-only,
  // order must belong to the lead, variables must resolve, the 30s duplicate guard, the
  // idempotent-insert send, Customer 360/Audit Trail via the existing Activity types) is identical,
  // because this is the exact same method underneath, not a parallel implementation. Used by both
  // E7.6's LifecycleAutomationService and E7.7's WhatsAppCampaignService - neither calls a provider
  // directly, and neither duplicates this send logic.
  async sendTemplateAsSystem(input: SendTemplateInput): Promise<WhatsAppMessageSummary> {
    return this.send({ kind: "system" }, input);
  }

  // Safe, manual test path for the AiSensy order-confirmation template - NOT wired into order
  // creation, Shopify sync, or any payment event; a real human, already authenticated and subject to
  // the same lead-scope RBAC as every other send in this file, must call this explicitly. Recipient,
  // name, order number and amount are always the real CRM data for `orderId` - never a caller-
  // supplied destination - and this delegates to the exact same `send()` used everywhere else, so
  // there is no second, parallel send implementation to keep in sync.
  async sendOrderConfirmationTest(user: AuthUser, input: SendOrderConfirmationTestInput): Promise<OrderConfirmationTestResult> {
    const leadScope = await getLeadScope(user, this.db);
    const order = await this.db.order.findFirst({
      where: scopedOrderWhere(input.orderId, leadScope),
      select: { id: true, leadId: true, lead: { select: { normalizedMobile: true } } },
    });
    // Out of scope reads the same as missing - same convention as every other order/lead lookup here.
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    if (!order.lead.normalizedMobile) throw new ApiError("This customer has no valid WhatsApp/mobile number on file", STATUS_CODES.BAD_REQUEST);

    const template = await this.db.whatsAppTemplate.findFirst({
      where: { provider: "AISENSY", name: ORDER_CONFIRMATION_TEMPLATE_NAME },
      select: { id: true, status: true },
    });
    if (!template) {
      throw new ApiError(
        `No WhatsApp template named "${ORDER_CONFIRMATION_TEMPLATE_NAME}" exists yet. Create it first: POST /api/whatsapp/templates with provider "AISENSY" and a body containing {{customer_name}}, {{order_number}}, {{order_amount}} in that order.`,
        STATUS_CODES.NOT_FOUND,
      );
    }
    if (template.status !== "APPROVED") {
      throw new ApiError(
        `The "${ORDER_CONFIRMATION_TEMPLATE_NAME}" template is ${template.status}, not APPROVED. AiSensy has no API to check a Campaign's live status, so this is confirmed and set manually once the Campaign is actually Live in the AiSensy dashboard.`,
        STATUS_CODES.BAD_REQUEST,
      );
    }

    const result = await this.send({ kind: "user", user }, { leadId: order.leadId, templateId: template.id, orderId: order.id });
    // send() persists a provider failure as a FAILED message rather than throwing (see the class
    // comment on `send`) - a test call must still surface that as a failure, never report success
    // for a message AiSensy actually rejected.
    if (result.status === "FAILED") {
      throw new ApiError(result.errorMessage ?? "AiSensy rejected the message", STATUS_CODES.BAD_REQUEST);
    }

    return {
      success: true,
      provider: "AISENSY",
      campaign: ORDER_CONFIRMATION_TEMPLATE_NAME,
      destination: maskDestination(order.lead.normalizedMobile),
      message: "WhatsApp message submitted successfully",
    };
  }

  private async send(actor: SendActor, input: SendTemplateInput): Promise<WhatsAppMessageSummary> {
    const { lead, order, template, resolution, provider } = await this.loadAndResolve(actor, input, { requireProviderMatch: true });
    if (resolution.errors.length > 0) throw new ApiError(resolution.errors[0], STATUS_CODES.BAD_REQUEST);
    if (!lead.normalizedMobile) throw new ApiError("This customer has no valid WhatsApp/mobile number on file", STATUS_CODES.BAD_REQUEST);
    if (input.mediaUrl) assertValidMediaUrl(input.mediaUrl); // fail fast, before any provider call or DB write

    if (!provider) throw new ApiError("WhatsApp is not configured", STATUS_CODES.SERVICE_UNAVAILABLE); // unreachable: requireProviderMatch resolved one

    // Duplicate-send guard: an identical send (same customer, template, order context) moments ago
    // returns that earlier attempt instead of sending again - never a new blocking window, and a
    // genuinely later resend (past DUPLICATE_GUARD_MS) always goes through.
    const recent = await this.db.whatsAppMessage.findFirst({
      where: {
        leadId: lead.id,
        templateId: template.id,
        orderId: order?.id ?? null,
        direction: "OUTBOUND",
        createdAt: { gte: new Date(Date.now() - DUPLICATE_GUARD_MS) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: MESSAGE_SELECT,
    });
    if (recent) return mapMessage(recent);

    const variableOrder = Array.isArray(template.variables) ? (template.variables as string[]) : [];
    const positionalParams = variableOrder.map((name) => resolution.values[name]);
    const contactName = fullName(lead.firstName, lead.lastName);
    // AiSensy's Campaign API is addressed by providerTemplateId (its own campaign identifier) - unchanged. Meta's Send
    // Message API takes the template's actual NAME (e.g. "hello_world"), never its numeric template id (what
    // providerTemplateId holds for a Meta-synced template) - sending that id 404s ("Meta Cloud API rejected the
    // template message (HTTP 404)"), confirmed live against a real Meta template before this fix.
    const providerTemplateName = provider.id === "META" ? template.name : (template.providerTemplateId ?? template.name);
    // The actual text this send resolved to and attempted to deliver - the same rendering
    // previewTemplate() already shows before sending. Bug fix: this was never persisted to
    // WhatsAppMessage.body (an existing column, already selected/returned everywhere), so every
    // template send's conversation history had no real message text to show, only the template
    // name. Stored regardless of send outcome, since a FAILED send still attempted this exact body.
    // When media is attached, its reference is appended to this same body - WhatsAppMessage has no
    // dedicated media column (and none is being added), so this existing free-text field is what
    // records it; the URL renders as a real clickable link in the Inbox (message-bubble.tsx already
    // linkifies it).
    const media = input.mediaUrl ? { url: input.mediaUrl, filename: input.mediaFilename } : undefined;
    const resolvedBody = renderTemplateBody(template.body, resolution.values) + (media ? `\n\n📎 ${media.filename ?? "Attachment"}: ${media.url}` : "");

    let providerMessageId: string | null = null;
    let sendError: WhatsAppSendError | null = null;
    try {
      const result = await provider.sendTemplateMessage({ to: lead.normalizedMobile, templateName: providerTemplateName, params: positionalParams, contactName, media, ...(provider.id === "META" ? { languageCode: template.language } : {}) });
      providerMessageId = result.providerMessageId;
    } catch (error) {
      if (error instanceof WhatsAppSendError) sendError = error;
      else throw error;
    }

    const now = new Date();
    // INSERT ... ON CONFLICT DO NOTHING (skipDuplicates), same idempotent-insert idiom
    // shopify.webhook.store.ts/whatsapp.webhook.store.ts already use: unlike a plain create() that
    // throws on the unique (provider, providerMessageId) constraint, this never raises an error, so
    // it is safe even when this.db is a caller-supplied transaction - a thrown, caught error inside
    // an explicit Postgres transaction aborts the whole transaction until rollback, which would
    // make any "catch and recover" attempt in the same transaction fail too.
    const id = randomUUID();
    const { count } = await this.db.whatsAppMessage.createMany({
      data: [
        {
          id,
          provider: provider.id,
          providerMessageId,
          direction: "OUTBOUND",
          messageType: "TEMPLATE",
          status: sendError ? "FAILED" : providerMessageId ? "SENT" : "QUEUED",
          leadId: lead.id,
          orderId: order?.id ?? null,
          templateId: template.id,
          toNumber: lead.normalizedMobile,
          normalizedContact: lead.normalizedMobile,
          templateName: template.name,
          body: resolvedBody,
          sentById: actor.kind === "user" ? actor.user.id : null,
          sentAt: sendError ? null : now,
          failedAt: sendError ? now : null,
          errorMessage: sendError ? sendError.message : null,
        },
      ],
      skipDuplicates: true,
    });

    if (count === 0) {
      // Lost a genuine race on providerMessageId: the request that won already wrote its own
      // message row and Activity, so this one returns that row rather than inventing a second event.
      const existing = await this.db.whatsAppMessage.findUniqueOrThrow({
        where: { provider_providerMessageId: { provider: provider.id, providerMessageId: providerMessageId! } },
        select: MESSAGE_SELECT,
      });
      return mapMessage(existing);
    }

    const row = await this.db.whatsAppMessage.findUniqueOrThrow({ where: { id }, select: MESSAGE_SELECT });

    await this.db.activity.create({
      data: {
        leadId: lead.id,
        orderId: order?.id,
        actorId: actor.kind === "user" ? actor.user.id : null,
        actorRole: actor.kind === "user" ? actor.user.role : null,
        type: sendError ? ActivityType.WHATSAPP_FAILED : ActivityType.WHATSAPP_MESSAGE_SENT,
        referenceType: REFERENCE_TYPE,
        referenceId: row.id,
        source: actor.kind === "user" ? ActivitySource.USER : ActivitySource.SYSTEM,
        title: sendError ? "WhatsApp message failed to send" : "WhatsApp template sent",
        description: sendError ? sendError.message : template.name,
      },
    });

    return mapMessage(row);
  }

  // Shared by preview and send: everything up to "here is the message that would be sent", so the
  // two flows can never disagree about what a template needs or whether it is actually sendable.
  private async loadAndResolve(
    actor: SendActor,
    input: PreviewTemplateInput,
    opts: { requireProviderMatch: boolean },
  ): Promise<{ lead: LeadRow; order: OrderRow | null; template: TemplateRow; resolution: { values: Record<string, string>; errors: string[] }; provider: WhatsAppProvider | null }> {
    // A human caller only ever reaches a lead already inside their own RBAC scope (E7.1's rule for
    // this endpoint). A system caller (E7.6) already resolved this exact lead from the business
    // event itself - the same direct-by-id trust level shopify.persist.ts's own lead lookups use -
    // so there is no separate human "can they see this lead" question to ask here.
    const lead =
      actor.kind === "user"
        ? await this.db.lead.findFirst({ where: scopedLeadWhere(input.leadId, await getLeadScope(actor.user, this.db)), select: LEAD_SELECT })
        : await this.db.lead.findFirst({ where: { id: input.leadId }, select: LEAD_SELECT });
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);

    const template = await this.db.whatsAppTemplate.findUnique({ where: { id: input.templateId }, select: TEMPLATE_SELECT });
    if (!template) throw new ApiError("Template not found", STATUS_CODES.NOT_FOUND);
    if (template.status !== "APPROVED") {
      throw new ApiError(TEMPLATE_STATUS_MESSAGES[template.status] ?? "This template cannot be sent.", STATUS_CODES.BAD_REQUEST);
    }

    let provider: WhatsAppProvider | null = null;
    if (opts.requireProviderMatch) {
      const resolved = await this.resolveSendProvider(actor, lead.id);
      provider = resolved.provider;
      if (provider.id !== template.provider) {
        throw new ApiError(
          resolved.fromConversation
            ? `This template belongs to ${template.provider}, but this conversation's provider is ${provider.id}. Choose a ${PROVIDER_DISPLAY_NAMES[provider.id]} template.`
            : `This template belongs to ${template.provider}, but the configured provider is ${provider.id}.`,
          STATUS_CODES.BAD_REQUEST,
        );
      }
    }

    let order: OrderRow | null = null;
    if (input.orderId) {
      // Never another customer's order: the where clause requires it to belong to this exact lead,
      // not merely to a lead the caller can see.
      order = await this.db.order.findFirst({ where: { id: input.orderId, leadId: lead.id }, select: ORDER_SELECT });
      if (!order) throw new ApiError("This order does not belong to the selected customer", STATUS_CODES.BAD_REQUEST);
    }

    const variableNames = Array.isArray(template.variables) ? (template.variables as string[]) : [];
    const ctx: VariableResolutionContext = {
      lead: { firstName: lead.firstName, lastName: lead.lastName, mobile: lead.mobile, normalizedMobile: lead.normalizedMobile, email: lead.email },
      order: order
        ? {
            orderNumber: order.orderNumber,
            externalNumber: order.externalNumber,
            status: order.status,
            currency: order.currency,
            totalAmount: order.totalAmount.toString(),
            payments: order.payments.map((p) => ({ status: p.status, method: p.method, amount: p.amount.toString(), refundedAmount: p.refundedAmount?.toString() ?? null, paymentUrl: p.paymentUrl, paymentExpiresAt: p.paymentExpiresAt })),
            latestShipment: order.shipments[0] ?? null,
          }
        : null,
    };

    const resolution = resolveTemplateVariables(variableNames, ctx);
    return { lead, order, template, resolution, provider };
  }
}

export default WhatsAppMessagingService;
