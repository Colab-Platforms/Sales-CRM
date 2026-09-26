// Sends a customer-facing WhatsApp notification for an order event (COD confirmation, a Cashfree
// payment link) through whichever provider the CUSTOMER's conversation is actually on - reusing the
// exact same rules already enforced elsewhere in this codebase, never a second/parallel routing
// decision:
//   - The active provider comes from findConversationProvider (whatsapp.conversation-provider.ts) -
//     the same resolver whatsapp.freetext.service.ts and whatsapp.messaging.service.ts use. The
//     global WHATSAPP_PROVIDER env var is never consulted here.
//   - META: free text only inside the 24-hour service window (WhatsAppFreeTextService, unchanged
//     rules); otherwise an APPROVED local template for provider META is required (same
//     ORDER_CONFIRMATION_TEMPLATE_NAME convention AiSensy already uses, and the existing
//     {{payment_link}} variable convention for a payment link).
//   - AISENSY/GUPSHUP: template only (their existing, unchanged rule - see whatsapp.messaging.service.ts).
// Every function here is best-effort BY DESIGN: it never throws. A failure (no conversation, no
// template, provider down, Meta not configured) is reported in the return value so the caller (an
// order or payment operation that must already be durably committed) is never rolled back or 500'd
// because a WhatsApp send did not go through.
import type { DbClient } from "@/lib/leadScope.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { AuthUser } from "@/middlewares/auth.js";
import type { WhatsAppProviderName } from "../../../generated/prisma/client.js";
import { findConversationProvider } from "./whatsapp.conversation-provider.js";
import WhatsAppFreeTextService from "./whatsapp.freetext.service.js";
import WhatsAppMessagingService, { ORDER_CONFIRMATION_TEMPLATE_NAME } from "./whatsapp.messaging.service.js";
import { buildOrderConfirmationMessage, buildPaymentLinkMessage, type MessageItem } from "./whatsapp.order-message.js";

// The variables the payment-link message is built around. A provider template that carries more of them reads closer to
// the free-text message; the only REQUIRED one is payment_link (a template without it would not deliver the link).
const PAYMENT_LINK_PREFERRED_VARIABLES = ["customer_name", "order_number", "product_summary", "amount", "payment_link"];

export type OrderNotifyVia = "FREE_TEXT" | "TEMPLATE";

export interface OrderNotifyResult {
  sent: boolean;
  via: OrderNotifyVia | null;
  provider: WhatsAppProviderName | null;
  /** Set only when sent is false - a safe, human-readable reason (never a credential/secret). */
  reason?: string;
}

export interface OrderNotifyDeps {
  freeText?: WhatsAppFreeTextService;
  messaging?: WhatsAppMessagingService;
}

/** The first APPROVED template for this provider whose variables include every name in `mustInclude`. */
/** Whether an APPROVED row is actually safe to send: a synced Gupshup/Meta template is only ever APPROVED with a
 *  real providerTemplateId (upsertSyncedTemplate always sets one - that is the whole point of a sync), so a
 *  APPROVED-but-no-providerTemplateId row for either can only mean corrupted/tampered data, never a legitimate
 *  state, and is refused rather than sent blind. AiSensy is the one deliberate exception: its Campaign API has no
 *  template-listing endpoint at all (see whatsapp.aisensy.provider.ts), so an AiSensy template can be marked
 *  APPROVED only by a human confirming it is live in the AiSensy dashboard - it never has a providerTemplateId by
 *  design (see the WhatsAppTemplate model's own comment), and that absence must not disqualify it. */
function isSendEligible(t: { provider: WhatsAppProviderName; providerTemplateId: string | null }): boolean {
  return t.provider === "AISENSY" || Boolean(t.providerTemplateId);
}

async function findApprovedTemplate(db: DbClient, provider: WhatsAppProviderName, mustInclude: string[], prefer: string[] = []): Promise<{ id: string } | null> {
  const candidates = (
    await db.whatsAppTemplate.findMany({
      where: { provider, status: "APPROVED" },
      select: { id: true, name: true, variables: true, providerTemplateId: true, provider: true },
      orderBy: [{ name: "asc" }],
    })
  ).filter(isSendEligible);
  // The existing shared naming convention (ORDER_CONFIRMATION_TEMPLATE_NAME) wins if present for this
  // provider, so an admin who follows that convention gets exactly the intended template, not just
  // whichever APPROVED one happens to sort first.
  const named = candidates.find((t) => t.name === ORDER_CONFIRMATION_TEMPLATE_NAME);
  const coverage = (t: { variables: unknown }) => (Array.isArray(t.variables) ? prefer.filter((v) => (t.variables as string[]).includes(v)).length : 0);
  // Best-covering template first (stable for ties, so the name order above still decides between equals).
  const ranked = prefer.length ? [...candidates].sort((a, b) => coverage(b) - coverage(a)) : candidates;
  const pool = named ? [named, ...ranked.filter((t) => t.id !== named.id)] : ranked;
  return pool.find((t) => Array.isArray(t.variables) && mustInclude.every((v) => (t.variables as string[]).includes(v))) ?? null;
}

async function sendViaFreeTextOrTemplate(
  db: DbClient,
  user: AuthUser,
  params: { leadId: string; orderId: string; normalizedMobile: string | null; freeTextBody: string; templateVariables: string[]; preferVariables?: string[] },
  deps: OrderNotifyDeps,
): Promise<OrderNotifyResult> {
  try {
    const { provider } = await findConversationProvider(db, params.leadId);
    if (!provider) return { sent: false, via: null, provider: null, reason: "This customer has no WhatsApp conversation yet." };

    if (provider === "META") {
      const freeText = deps.freeText ?? new WhatsAppFreeTextService(db);
      if (!params.normalizedMobile) return { sent: false, via: null, provider, reason: "This customer has no valid WhatsApp/mobile number on file." };
      const { capability } = await freeText.getCapability(params.leadId);
      if (capability.freeText.allowed) {
        await freeText.sendText({ id: params.leadId, normalizedMobile: params.normalizedMobile }, params.freeTextBody, user.id, params.orderId);
        return { sent: true, via: "FREE_TEXT", provider };
      }
      // Window closed (or Meta briefly unconfigured) - fall through to the template path below, same
      // as every other provider, using a template approved for META specifically.
    }

    const template = await findApprovedTemplate(db, provider, params.templateVariables, params.preferVariables);
    if (!template) {
      return {
        sent: false,
        via: null,
        provider,
        reason:
          provider === "META"
            ? `The 24-hour WhatsApp window is closed and no approved Meta template with the required variables (${params.templateVariables.join(", ")}) is configured. Create/sync one, or notify the customer manually.`
            : `No approved ${provider} template with the required variables (${params.templateVariables.join(", ")}) is configured. Create one (e.g. named "${ORDER_CONFIRMATION_TEMPLATE_NAME}"), or notify the customer manually.`,
      };
    }

    const messaging = deps.messaging ?? new WhatsAppMessagingService(db);
    const result = await messaging.sendTemplate(user, { leadId: params.leadId, templateId: template.id, orderId: params.orderId });
    if (result.status === "FAILED") return { sent: false, via: "TEMPLATE", provider, reason: result.errorMessage ?? `${provider} rejected the message` };
    return { sent: true, via: "TEMPLATE", provider };
  } catch (error) {
    // Never thrown further: the OMS/payment operation this is attached to has already succeeded and
    // must stay that way regardless of what happens here.
    return { sent: false, via: null, provider: null, reason: error instanceof Error ? error.message : "WhatsApp notification failed" };
  }
}

/** Remembers the last notification outcome on the order itself (Order.metadata - the existing free-form JSON field, no
 *  schema change), so the order page can still show "Sent / Not sent + why" after a reload. Best-effort and never
 *  throws; only a safe, human-readable reason is stored - never a URL, token or credential. */
export async function recordOrderNotification(db: DbClient, orderId: string, result: OrderNotifyResult, now: Date = new Date()): Promise<void> {
  try {
    const order = await db.order.findUnique({ where: { id: orderId }, select: { metadata: true } });
    if (!order) return;
    const meta = (order.metadata as Record<string, unknown> | null) ?? {};
    const entry = { sent: result.sent, via: result.via, provider: result.provider, ...(result.reason ? { reason: result.reason } : {}), at: now.toISOString() };
    await db.order.update({ where: { id: orderId }, data: { metadata: { ...meta, whatsappNotification: entry } as Prisma.InputJsonValue } });
  } catch {
    // The notification itself already happened (or was reported); losing this bookkeeping must never fail the caller.
  }
}

/** COD order confirmation - sent right after a manual order is created. */
export async function notifyOrderConfirmation(
  db: DbClient,
  user: AuthUser,
  params: { leadId: string; orderId: string; normalizedMobile: string | null; orderNumber: string; totalAmount: string; currency: string; customerName?: string; items?: MessageItem[] },
  deps: OrderNotifyDeps = {},
): Promise<OrderNotifyResult> {
  const freeTextBody = buildOrderConfirmationMessage({ customerName: params.customerName, orderNumber: params.orderNumber, items: params.items, amount: params.totalAmount, currency: params.currency });
  return sendViaFreeTextOrTemplate(db, user, { ...params, freeTextBody, templateVariables: ["customer_name", "order_number", "order_amount"] }, deps);
}

/** A Cashfree payment link - sent right after it is created (either at order-creation time for a
 *  prepaid order, or from the existing manual "send payment link" action). */
export async function notifyPaymentLink(
  db: DbClient,
  user: AuthUser,
  params: { leadId: string; orderId: string; normalizedMobile: string | null; orderNumber: string; paymentUrl: string; amount: string; currency: string; customerName?: string; items?: MessageItem[] },
  deps: OrderNotifyDeps = {},
): Promise<OrderNotifyResult> {
  const freeTextBody = buildPaymentLinkMessage({ customerName: params.customerName, orderNumber: params.orderNumber, items: params.items, amount: params.amount, currency: params.currency, paymentUrl: params.paymentUrl });
  return sendViaFreeTextOrTemplate(db, user, { ...params, freeTextBody, templateVariables: ["payment_link"], preferVariables: PAYMENT_LINK_PREFERRED_VARIABLES }, deps);
}

const PAYMENT_SUCCESS_PREFERRED_VARIABLES = ["customer_name", "order_number", "product_summary", "amount"];

/** "Payment received" - sent once a Cashfree payment actually settles (never for COD, which is never
 *  "received" up front). Triggered from the Cashfree webhook, which has no authenticated user, so - unlike
 *  the confirmation/payment-link notifications above - this is TEMPLATE-ONLY, sent as the system actor
 *  (WhatsAppMessagingService.sendTemplateAsSystem), the same actor convention already used by
 *  LifecycleAutomationService/WhatsAppCampaignService for non-user-initiated sends. It does not attempt Meta
 *  free text: that path needs a real `AuthUser` for `sentById`, which a webhook does not have. */
export async function notifyPaymentSuccess(
  db: DbClient,
  params: { leadId: string; orderId: string; orderNumber: string; amount: string; currency: string; customerName?: string; items?: MessageItem[] },
  deps: OrderNotifyDeps = {},
): Promise<OrderNotifyResult> {
  try {
    const { provider } = await findConversationProvider(db, params.leadId);
    if (!provider) return { sent: false, via: null, provider: null, reason: "This customer has no WhatsApp conversation yet." };

    const template = await findApprovedTemplate(db, provider, ["amount"], PAYMENT_SUCCESS_PREFERRED_VARIABLES);
    if (!template) {
      return { sent: false, via: null, provider, reason: `No approved ${provider} template with the required variables (amount) is configured for a payment-received notice.` };
    }

    const messaging = deps.messaging ?? new WhatsAppMessagingService(db);
    const result = await messaging.sendTemplateAsSystem({ leadId: params.leadId, templateId: template.id, orderId: params.orderId });
    if (result.status === "FAILED") return { sent: false, via: "TEMPLATE", provider, reason: result.errorMessage ?? `${provider} rejected the message` };
    return { sent: true, via: "TEMPLATE", provider };
  } catch (error) {
    return { sent: false, via: null, provider: null, reason: error instanceof Error ? error.message : "WhatsApp notification failed" };
  }
}
