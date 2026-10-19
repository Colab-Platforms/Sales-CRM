// "Send Payment Link via WhatsApp" on Create Order: the telecaller's choice and what it needs before the order can be created. The server
// validates everything again (number, consent, approved Meta payment template) - this only keeps the screen honest and the payload minimal.
export interface PaymentTemplateOption {
  id: string;
  name: string;
  language: string;
  category: string | null;
  provider: "META";
  variables: string[];
  usableForPaymentLink: boolean;
  isDefault: boolean;
}

export type WhatsAppConsentStatus = "OPTED_IN" | "OPTED_OUT" | "UNKNOWN" | null;

export interface WhatsAppPaymentOptions {
  templates: PaymentTemplateOption[];
  consent: WhatsAppConsentStatus;
  hasWhatsAppNumber: boolean;
  /** false = the customer has never been messaged on WhatsApp, so a template is a business-initiated FIRST contact. */
  hasConversation?: boolean;
}

export interface WhatsAppPaymentChoice {
  /** false = "Don't send" (the default). */
  send: boolean;
  /** null = the default template (prepaid_template when listed). */
  templateId: string | null;
  /** "Customer has agreed to receive WhatsApp updates". */
  consent: boolean;
}

export const NO_WHATSAPP: WhatsAppPaymentChoice = { send: false, templateId: null, consent: false };

/** The template that is selected: the picked one if still listed, else the default (prepaid_template), else the first. */
export function selectedTemplate(options: WhatsAppPaymentOptions | null, choice: WhatsAppPaymentChoice): PaymentTemplateOption | null {
  const list = options?.templates ?? [];
  return list.find((t) => t.id === choice.templateId) ?? list.find((t) => t.isDefault) ?? list[0] ?? null;
}

/** Why "Create Order & Send Payment Link" cannot proceed yet (null = it can). Consent already recorded as OPTED_IN needs no tick. */
export function whatsappBlockReason(options: WhatsAppPaymentOptions | null, loading: boolean, choice: WhatsAppPaymentChoice, failed = false): string | null {
  if (!choice.send) return null;
  // A failed load leaves `options` null; that is NOT "still loading" - say so, and say what can be done.
  if (failed && !options) return "WhatsApp options could not be loaded. Retry, or choose Don't send to create the order and share the payment link yourself.";
  if (loading || !options) return "Loading WhatsApp options…";
  if (!options.hasWhatsAppNumber) return "This customer does not have a valid WhatsApp number.";
  if (options.consent === "OPTED_OUT") return "This customer has opted out of WhatsApp messages. Update their consent through the consent flow first.";
  if (!selectedTemplate(options, choice)) return "No approved WhatsApp payment template is available.";
  if (options.consent !== "OPTED_IN" && !choice.consent) return "Confirm that the customer has agreed to receive WhatsApp updates.";
  return null;
}

/** The request fields for the choice. Nothing is added for "Don't send" other than the explicit false. */
export function toApiWhatsApp(options: WhatsAppPaymentOptions | null, choice: WhatsAppPaymentChoice): { sendPaymentLinkViaWhatsApp: boolean; whatsappTemplateId?: string; whatsappConsent?: boolean } {
  if (!choice.send) return { sendPaymentLinkViaWhatsApp: false };
  const template = selectedTemplate(options, choice);
  return {
    sendPaymentLinkViaWhatsApp: true,
    ...(template ? { whatsappTemplateId: template.id } : {}),
    ...(options?.consent !== "OPTED_IN" && choice.consent ? { whatsappConsent: true } : {}),
  };
}

/** Why the WhatsApp options did not load, in words a telecaller can act on. Reads only the HTTP status of the failed request - never its body or any credentials. */
export function describeOptionsLoadError(error: unknown): string {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (status === 401) return "Your session has expired. Sign in again, then retry.";
  if (status === 403) return "You do not have permission to send payment links on WhatsApp.";
  if (status === 404) return "This customer was not found or is not assigned to you, so WhatsApp options are unavailable.";
  if (status === 503) return "The system database is temporarily unavailable. Retry in a few minutes.";
  if (status === undefined) return "Could not reach the server. Check your connection, then retry.";
  return "Could not load WhatsApp options. Retry, or choose Don't send.";
}

/** Whether Create Order is offered for an open chat. The SERVER decides (conversation detail: normal lead scope, or this chat is assigned to the user, plus a usable phone number) - it does not depend
 *  on the optional Customer 360 lookup or on the payment-options request, and not on WhatsApp consent (consent only gates *sending*). It also names the lead to create the order under (a chat is one
 *  row per phone, so that may be a sibling lead the user is entitled to). Against an older backend that does not send the decision, the previous rule (an editable Customer 360 record) applies.
 *  If the decision itself could not be loaded, say so and offer to retry it - never a silently disabled button. */
export function resolveCreateOrderAccess(
  detail: { canCreateOrder?: boolean; createOrderBlockedReason?: string | null; orderLead?: { id: string; name: string } | null } | null | undefined,
  customer: { readOnly?: boolean } | null | undefined,
  opts: { detailFailed?: boolean } = {},
): { allowed: boolean; reason: string | null; orderLeadId: string | null; orderLeadName: string | null; canRetry: boolean } {
  const none = { orderLeadId: null, orderLeadName: null, canRetry: false };
  if (detail && typeof detail.canCreateOrder === "boolean") {
    return detail.canCreateOrder
      ? { allowed: true, reason: null, orderLeadId: detail.orderLead?.id ?? null, orderLeadName: detail.orderLead?.name ?? null, canRetry: false }
      : { allowed: false, reason: detail.createOrderBlockedReason ?? "You cannot create an order from this chat.", ...none };
  }
  if (customer && !customer.readOnly) return { allowed: true, reason: null, ...none };
  if (customer?.readOnly) return { allowed: false, reason: "This customer belongs to another team. Ask a manager or admin to assign the chat or the customer to you.", ...none };
  if (opts.detailFailed) return { allowed: false, reason: "We could not check whether you can create an order from this chat. Retry.", orderLeadId: null, orderLeadName: null, canRetry: true };
  return { allowed: false, reason: null, ...none };
}
