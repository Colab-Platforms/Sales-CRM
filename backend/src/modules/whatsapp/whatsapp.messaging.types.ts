import type { TemplateVariableField } from "./whatsapp.variable-resolver.js";

export interface SendTemplateInput {
  leadId: string;
  templateId: string;
  orderId?: string;
  /** Optional media attached to this same template send (AiSensy's documented `media: {url,
   *  filename}` field on the Campaign API). Must already be a publicly accessible https URL - the
   *  CRM has no file-hosting service of its own, so it never uploads anything on the caller's
   *  behalf; see whatsapp.messaging.service.ts's assertValidMediaUrl for what's rejected. */
  mediaUrl?: string;
  mediaFilename?: string;
  /** Per-variable values the caller (the Send WhatsApp UI) typed in - the only source for a variable
   *  this CRM has no automatic CRM data for (e.g. a one-off campaign detail like webinar_name), and
   *  an optional override for one it does (see whatsapp.variable-resolver.ts's resolveTemplateVariables). */
  manualValues?: Record<string, string>;
}

export type PreviewTemplateInput = SendTemplateInput;

export interface TemplatePreviewResult {
  templateId: string;
  templateName: string;
  provider: string;
  language: string;
  resolvedBody: string;
  variables: Record<string, string>;
  /** One entry per variable this template actually declares, normalized once on the backend (see
   *  whatsapp.variable-resolver.ts's TemplateVariableField) so the Send WhatsApp UI never has to
   *  maintain its own copy of which variables are CRM-resolvable vs need a typed value. */
  fields: TemplateVariableField[];
}

// Safe, manual "does this actually work" path for the AiSensy order-confirmation template - see
// whatsapp.messaging.service.ts's sendOrderConfirmationTest. Deliberately narrower than
// SendTemplateInput: only an orderId, so the recipient always comes from CRM data, never an
// arbitrary destination a caller supplies.
export interface SendOrderConfirmationTestInput {
  orderId: string;
}

export interface OrderConfirmationTestResult {
  success: true;
  provider: string;
  /** The AiSensy Campaign name this send used - the local WhatsAppTemplate's own name (see
   *  ORDER_CONFIRMATION_TEMPLATE_NAME), never a value invented here. */
  campaign: string;
  /** Masked - e.g. "********3210" - never the full number. */
  destination: string;
  message: string;
}
