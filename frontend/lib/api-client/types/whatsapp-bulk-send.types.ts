// Kept in sync with backend/src/modules/whatsapp/whatsapp.bulk-send.types.ts.

export type BulkRecipientStatus = "READY" | "MISSING_VARIABLE" | "OPTED_OUT" | "INVALID_PHONE" | "TEMPLATE_NOT_SENDABLE" | "PROVIDER_ERROR" | "NOT_FOUND" | "NOT_ALLOWED" | "DUPLICATE_PHONE" | "CUSTOMER_DEACTIVATED";

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
  reason: string | null;
  resolvedBody: string | null;
}

export interface BulkClassifyResult {
  templateId: string;
  templateName: string;
  recipients: BulkRecipient[];
  summary: Record<BulkRecipientStatus, number>;
}

export type BulkSendInput = BulkClassifyInput;

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
