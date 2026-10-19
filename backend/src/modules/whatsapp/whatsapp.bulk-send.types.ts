// Parts 3-5 (WhatsApp Inbox): bulk/selected-chat sending. Every recipient is classified into exactly
// one of these before anything is sent - never a silent skip. Only READY recipients are ever sent to.
export type BulkRecipientStatus = "READY" | "MISSING_VARIABLE" | "OPTED_OUT" | "INVALID_PHONE" | "TEMPLATE_NOT_SENDABLE" | "PROVIDER_ERROR" | "CUSTOMER_DEACTIVATED" | "NOT_FOUND" | "NOT_ALLOWED" | "DUPLICATE_PHONE";

export interface BulkClassifyInput {
  leadIds: string[];
  templateId: string;
  manualValues?: Record<string, string>;
}

export interface BulkRecipient {
  leadId: string;
  name: string;
  mobile: string | null;
  status: BulkRecipientStatus;
  /** Always present for a non-READY recipient - the exact, specific reason, never a generic "cannot send". */
  reason: string | null;
  resolvedBody: string | null;
}

export interface BulkClassifyResult {
  templateId: string;
  templateName: string;
  recipients: BulkRecipient[];
  summary: Record<BulkRecipientStatus, number>;
}

export interface BulkSendInput extends BulkClassifyInput {}

export interface BulkSendRecipientResult {
  leadId: string;
  name: string;
  status: BulkRecipientStatus | "SENT" | "FAILED";
  reason: string | null;
}

export interface BulkSendResult {
  templateId: string;
  sent: number;
  failed: number;
  skipped: number;
  recipients: BulkSendRecipientResult[];
}
