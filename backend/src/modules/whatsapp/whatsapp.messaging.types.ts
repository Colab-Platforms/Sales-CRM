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
}

export type PreviewTemplateInput = SendTemplateInput;

export interface TemplatePreviewResult {
  templateId: string;
  templateName: string;
  provider: string;
  language: string;
  resolvedBody: string;
  variables: Record<string, string>;
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
