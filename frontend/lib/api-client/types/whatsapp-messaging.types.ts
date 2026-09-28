// Kept in sync with backend/src/modules/whatsapp/whatsapp.messaging.types.ts and whatsapp.types.ts.

export interface SendTemplateInput {
  leadId: string;
  templateId: string;
  orderId?: string;
  /** Optional media attached to this same template send (AiSensy's documented `media: {url,
   *  filename}` field). Must already be a publicly accessible https URL - the CRM has no
   *  file-hosting service, so there is no upload here, only a URL the user already has. */
  mediaUrl?: string;
  mediaFilename?: string;
  /** Per-variable values typed into the Send WhatsApp UI - the only source for a variable this CRM
   *  has no CRM data for (source: "manual" in TemplateVariableField below), and an optional override
   *  for one it does. */
  manualValues?: Record<string, string>;
}

export type PreviewTemplateInput = SendTemplateInput;

export type TemplateVariableSource = "crm" | "manual";

export interface TemplateVariableField {
  name: string;
  /** "crm" = this CRM can auto-fill it from the lead/order; "manual" = no automatic source exists,
   *  so the user must type a value (or already has, if `value` is non-null). */
  source: TemplateVariableSource;
  value: string | null;
}

export interface TemplatePreviewResult {
  templateId: string;
  templateName: string;
  provider: string;
  language: string;
  resolvedBody: string;
  variables: Record<string, string>;
  fields: TemplateVariableField[];
}

export type WhatsAppMessageStatus = "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "RECEIVED";

export interface WhatsAppMessageResult {
  id: string;
  provider: string;
  direction: "INBOUND" | "OUTBOUND";
  messageType: string;
  status: WhatsAppMessageStatus;
  providerMessageId: string | null;
  templateName: string | null;
  templateId: string | null;
  orderId: string | null;
  body: string | null;
  errorMessage: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  receivedAt: string | null;
}
