// "Send Payment Link via WhatsApp" on Create Order: which approved Meta templates a telecaller may pick, and the checks that must pass
// BEFORE an order is created for a send (number, template, consent). Consent is the existing CommunicationPreference record - nothing is
// assumed: OPTED_IN already recorded, or the telecaller ticks "customer has agreed" (recorded together with the order), and an OPTED_OUT
// customer is never overwritten here.
import type { DbClient } from "@/lib/leadScope.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { classifyVariable } from "../whatsapp/whatsapp.variable-resolver.js";
import { findConversationProvider } from "../whatsapp/whatsapp.conversation-provider.js";

export const PAYMENT_TEMPLATE_REQUIRED_VARIABLE = "payment_link";
export const DEFAULT_PAYMENT_TEMPLATE_NAME = "prepaid_template";
export const CONSENT_SOURCE = "CREATE_ORDER";

export interface PaymentTemplateOption {
  id: string;
  name: string;
  language: string;
  category: string | null;
  provider: "META";
  variables: string[];
  /** True when it carries {{payment_link}} - every listed template does; present so the UI can state it. */
  usableForPaymentLink: boolean;
  isDefault: boolean;
}

export type ConsentStatus = "OPTED_IN" | "OPTED_OUT" | "UNKNOWN" | null;

export interface WhatsAppPaymentOptions {
  templates: PaymentTemplateOption[];
  /** The customer's recorded WhatsApp consent (null = nothing recorded). */
  consent: ConsentStatus;
  hasWhatsAppNumber: boolean;
  /** The customer already has a WhatsApp conversation/history. false = a template would be a business-initiated FIRST contact (needs OPTED_IN). */
  hasConversation: boolean;
}

/** A template row that can send a payment link: META, APPROVED, really synced (has Meta's template id), and with {{payment_link}}. */
export function isPaymentTemplate(t: { provider: string; status: string; providerTemplateId: string | null; variables: unknown }): boolean {
  return t.provider === "META" && t.status === "APPROVED" && Boolean(t.providerTemplateId) && Array.isArray(t.variables) && (t.variables as string[]).includes(PAYMENT_TEMPLATE_REQUIRED_VARIABLE);
}

/** Every variable of the template is one this CRM fills automatically from the order/customer (a template needing a hand-typed value cannot be sent for a payment link). */
export function unresolvableVariables(t: { variables: unknown }): string[] {
  return Array.isArray(t.variables) ? (t.variables as string[]).filter((v) => classifyVariable(v) !== "crm") : [];
}

export async function listPaymentTemplates(db: DbClient): Promise<PaymentTemplateOption[]> {
  const rows = await db.whatsAppTemplate.findMany({
    where: { provider: "META", status: "APPROVED" },
    select: { id: true, name: true, language: true, category: true, provider: true, status: true, providerTemplateId: true, variables: true },
    orderBy: [{ name: "asc" }],
  });
  return rows
    .filter((t) => isPaymentTemplate(t) && unresolvableVariables(t).length === 0)
    .map((t) => ({ id: t.id, name: t.name, language: t.language, category: t.category, provider: "META" as const, variables: t.variables as string[], usableForPaymentLink: true, isDefault: t.name === DEFAULT_PAYMENT_TEMPLATE_NAME }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

async function consentOf(db: DbClient, leadId: string): Promise<ConsentStatus> {
  const row = await db.communicationPreference.findUnique({ where: { leadId_channel: { leadId, channel: "WHATSAPP" } }, select: { status: true } });
  return row ? (row.status as ConsentStatus) : null;
}

export async function getWhatsAppPaymentOptions(db: DbClient, lead: { id: string; normalizedMobile: string | null }): Promise<WhatsAppPaymentOptions> {
  const { provider } = await findConversationProvider(db, lead.id);
  return { templates: await listPaymentTemplates(db), consent: await consentOf(db, lead.id), hasWhatsAppNumber: Boolean(lead.normalizedMobile), hasConversation: provider !== null };
}

const bad = (message: string) => new ApiError(message, STATUS_CODES.BAD_REQUEST);

/**
 * Everything that must hold before an order is created for a WhatsApp payment-link send. Throws a clear 400 (nothing is created) when the
 * customer has no valid WhatsApp number, has opted out, has no consent (recorded or confirmed now), or the chosen template is not an approved
 * Meta payment template. Returns what to do: which template, and whether the ticked consent must be recorded with the order.
 */
export async function validateWhatsAppPaymentSend(
  db: DbClient,
  lead: { id: string; normalizedMobile: string | null },
  input: { paymentMethod: string; whatsappTemplateId?: string; whatsappConsent?: boolean },
): Promise<{ templateId: string | null; recordConsent: boolean }> {
  if (input.paymentMethod !== "PAYMENT_LINK") throw bad("A WhatsApp payment link can only be sent for a payment-link (prepaid) order.");
  if (!lead.normalizedMobile) throw bad("Payment link not sent — this customer does not have a valid WhatsApp number.");

  let templateId: string | null = null;
  if (input.whatsappTemplateId) {
    const t = await db.whatsAppTemplate.findUnique({ where: { id: input.whatsappTemplateId }, select: { provider: true, status: true, providerTemplateId: true, variables: true } });
    if (!t || !isPaymentTemplate(t)) throw bad("Payment link not sent — the selected WhatsApp template is not available or approved.");
    const manual = unresolvableVariables(t);
    if (manual.length > 0) throw bad(`Cannot send WhatsApp template: it needs ${manual.join(", ")}, which the CRM cannot fill in automatically for a payment link.`);
    templateId = input.whatsappTemplateId;
  }

  const consent = await consentOf(db, lead.id);
  if (consent === "OPTED_OUT") throw bad("This customer has opted out of WhatsApp messages. Update their consent through the consent flow before sending a payment link on WhatsApp.");
  if (consent === "OPTED_IN") return { templateId, recordConsent: false }; // already recorded - preserved, never duplicated
  if (!input.whatsappConsent) throw bad("Payment link not sent — WhatsApp consent is required before sending a business-initiated message.");
  return { templateId, recordConsent: true };
}

/** Records the ticked consent (inside the order transaction). Never overwrites OPTED_OUT, never duplicates an OPTED_IN. */
export async function recordWhatsAppConsent(tx: DbClient, leadId: string, now: Date): Promise<void> {
  const existing = await tx.communicationPreference.findUnique({ where: { leadId_channel: { leadId, channel: "WHATSAPP" } }, select: { status: true } });
  if (existing?.status === "OPTED_IN" || existing?.status === "OPTED_OUT") return;
  if (existing) {
    await tx.communicationPreference.update({ where: { leadId_channel: { leadId, channel: "WHATSAPP" } }, data: { status: "OPTED_IN", consentAt: now, optedOutAt: null, source: CONSENT_SOURCE } });
  } else {
    await tx.communicationPreference.create({ data: { leadId, channel: "WHATSAPP", status: "OPTED_IN", consentAt: now, source: CONSENT_SOURCE } });
  }
}
