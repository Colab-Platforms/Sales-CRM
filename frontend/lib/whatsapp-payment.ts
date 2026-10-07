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
export function whatsappBlockReason(options: WhatsAppPaymentOptions | null, loading: boolean, choice: WhatsAppPaymentChoice): string | null {
  if (!choice.send) return null;
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
