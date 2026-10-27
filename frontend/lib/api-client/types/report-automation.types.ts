/** What data the report covers: the day it is sent, the previous day, one chosen calendar day (any send day), or the seven complete days before the send day. */
export type ReportMode = "TODAY" | "YESTERDAY" | "DATE" | "LAST7DAYS";

export interface ReportOptions {
  teamSummary: boolean;
  calls: boolean;
  leads: boolean;
  sales: boolean;
  followUps: boolean;
}

export interface ReportRecipient {
  id: string;
  name: string | null;
  phone: string;
}

export interface ReportAutomationConfig {
  id: string | null;
  enabled: boolean;
  recipients: ReportRecipient[];
  sendTime: string;
  timezone: string;
  reportFor: ReportMode;
  /** The saved calendar day (YYYY-MM-DD) when reportFor is DATE, else null. */
  dataDate: string | null;
  templateName: string | null;
  languageCode: string;
  options: ReportOptions;
  /** The roster: ids of the telecallers the report covers. Empty = every active telecaller in scope. */
  includedUserIds: string[];
  sendText: boolean;
  sendExcel: boolean;
  updatedAt: string | null;
}

export interface ReportAutomationConfigInput {
  enabled: boolean;
  recipients: { name?: string; phone: string }[];
  sendTime: string;
  timezone: string;
  reportFor: ReportMode;
  dataDate: string | null;
  templateName: string;
  languageCode: string;
  options: ReportOptions;
  includedUserIds: string[];
  sendText: boolean;
  sendExcel: boolean;
}

export interface ReportPersonRow {
  id: string;
  name: string;
  leads: number;
  contacted: number;
  interested: number;
  converted: number;
  conversionPct: number | null;
  calls: number;
  connected: number;
  talkTimeSec: number;
  orders: number;
  revenue: number;
  cancelledOrders: number;
  pendingFollowUps: number;
}

export interface ReportPreview {
  reportDate: string;
  /** First day covered (equal to reportDate for a single day). */
  reportFrom: string;
  periodLabel: string;
  timezone: string;
  offsetMinutes: number;
  options: ReportOptions;
  /** The readable message. */
  text: string;
  /** What the WhatsApp template receives (one line). */
  whatsappText: string;
  truncated: boolean;
  data: { scope: { id: string; name: string }[]; people: ReportPersonRow[]; team: Omit<ReportPersonRow, "id" | "name"> & { telecallers: number } };
}

export type ReportRecipientStatus = "PENDING" | "SENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "UNCERTAIN" | "WAITING_FOR_REPLY" | "SKIPPED";

/** One WhatsApp message of a recipient: the text template message, or the Excel document. */
export interface ReportMessagePart {
  status: ReportRecipientStatus;
  attempts: number;
  lastAttemptAt: string | null;
  error: string | null;
  providerMessageId: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  canRetry: boolean;
}

/** One recipient's result for one report run. `phone` is MASKED by the server. */
export interface ReportRecipientResult {
  id: string;
  name: string | null;
  phone: string;
  status: ReportRecipientStatus;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  error: string | null;
  providerMessageId: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  canRetry: boolean;
  /** The formatted multi-line report as a free-form text message - a separate message with its own status. */
  detail: ReportMessagePart;
  /** The Excel file - a separate message with its own status. */
  document: ReportMessagePart;
}

export interface ReportDelivery {
  id: string;
  kind: "SCHEDULED" | "TEST";
  reportDate: string;
  /** First day covered; differs from reportDate for a multi-day report. */
  reportFrom: string;
  scheduledFor: string | null;
  status: ReportRecipientStatus;
  createdAt: string;
  updatedAt: string;
  recipients: ReportRecipientResult[];
}

export interface ReportAutomationStatus {
  scheduler: { lastTickAt: string | null; lastSource: string | null; lastError: string | null; running: boolean; secondsSinceLastTick: number | null };
  whatsapp: { metaConfigured: boolean; envProviderConfigured: boolean; templates: { name: string; provider: string; language: string; status: string }[]; unusableTemplates: { name: string; provider: string; language: string; status: string; reason: string }[] };
  externalCronConfigured: boolean;
  nextRun: { at: string | null; dueNow: boolean; reason: string | null };
  /** The most recent SCHEDULED run (never a manual test), or null if none has happened. */
  lastScheduled: ReportDelivery | null;
  requiredTemplate: string;
}

export interface ReportDeliveryPage {
  items: ReportDelivery[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}
