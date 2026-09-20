import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { fullName } from "../orders/orders.filters.js";
import { scopedLeadWhere } from "../customers/customers.filters.js";
import { getWhatsAppProvider } from "./whatsapp.factory.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";
import { renderTemplateBody } from "./whatsapp.template.variables.js";
import type { PreviewTemplateInput, SendTemplateInput, TemplatePreviewResult } from "./whatsapp.messaging.types.js";
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
  payments: { select: { status: true, method: true, amount: true, refundedAmount: true } },
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

class WhatsAppMessagingService {
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getProvider: () => WhatsAppProvider | null = getWhatsAppProvider,
  ) {}

  async previewTemplate(user: AuthUser, input: PreviewTemplateInput): Promise<TemplatePreviewResult> {
    const { template, resolution } = await this.loadAndResolve(user, input, { requireProviderMatch: false });
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
    const { lead, order, template, resolution } = await this.loadAndResolve(user, input, { requireProviderMatch: true });
    if (resolution.errors.length > 0) throw new ApiError(resolution.errors[0], STATUS_CODES.BAD_REQUEST);
    if (!lead.normalizedMobile) throw new ApiError("This customer has no valid WhatsApp/mobile number on file", STATUS_CODES.BAD_REQUEST);

    const provider = this.getProvider()!; // loadAndResolve already confirmed this is non-null and matches the template

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
    const providerTemplateName = template.providerTemplateId ?? template.name;

    let providerMessageId: string | null = null;
    let sendError: WhatsAppSendError | null = null;
    try {
      const result = await provider.sendTemplateMessage({ to: lead.normalizedMobile, templateName: providerTemplateName, params: positionalParams, contactName });
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
          sentById: user.id,
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
        actorId: user.id,
        actorRole: user.role,
        type: sendError ? ActivityType.WHATSAPP_FAILED : ActivityType.WHATSAPP_MESSAGE_SENT,
        referenceType: REFERENCE_TYPE,
        referenceId: row.id,
        source: ActivitySource.USER,
        title: sendError ? "WhatsApp message failed to send" : "WhatsApp template sent",
        description: sendError ? sendError.message : template.name,
      },
    });

    return mapMessage(row);
  }

  // Shared by preview and send: everything up to "here is the message that would be sent", so the
  // two flows can never disagree about what a template needs or whether it is actually sendable.
  private async loadAndResolve(
    user: AuthUser,
    input: PreviewTemplateInput,
    opts: { requireProviderMatch: boolean },
  ): Promise<{ lead: LeadRow; order: OrderRow | null; template: TemplateRow; resolution: { values: Record<string, string>; errors: string[] } }> {
    const leadScope = await getLeadScope(user, this.db);
    const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(input.leadId, leadScope), select: LEAD_SELECT });
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);

    const template = await this.db.whatsAppTemplate.findUnique({ where: { id: input.templateId }, select: TEMPLATE_SELECT });
    if (!template) throw new ApiError("Template not found", STATUS_CODES.NOT_FOUND);
    if (template.status !== "APPROVED") {
      throw new ApiError(TEMPLATE_STATUS_MESSAGES[template.status] ?? "This template cannot be sent.", STATUS_CODES.BAD_REQUEST);
    }

    if (opts.requireProviderMatch) {
      const provider = this.getProvider();
      if (!provider) throw new ApiError("WhatsApp is not configured", STATUS_CODES.SERVICE_UNAVAILABLE);
      if (provider.id !== template.provider) {
        throw new ApiError(`This template belongs to ${template.provider}, but the configured provider is ${provider.id}.`, STATUS_CODES.BAD_REQUEST);
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
            payments: order.payments.map((p) => ({ status: p.status, method: p.method, amount: p.amount.toString(), refundedAmount: p.refundedAmount?.toString() ?? null })),
            latestShipment: order.shipments[0] ?? null,
          }
        : null,
    };

    const resolution = resolveTemplateVariables(variableNames, ctx);
    return { lead, order, template, resolution };
  }
}

export default WhatsAppMessagingService;
