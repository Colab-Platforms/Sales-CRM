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
  /** A disabled recipient stays on the list but is skipped by scheduled sends. */
  enabled: boolean;
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
  /** When ON, any one recipient replying to the summary message releases the detailed report and Excel to every recipient. */
  replyTriggersDetail: boolean;
  updatedAt: string | null;
}

export interface ReportAutomationConfigInput {
  enabled: boolean;
  recipients: { name?: string; phone: string; enabled?: boolean }[];
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
  /** When ON, any one recipient replying to the summary message releases the detailed report and Excel to every recipient. */
  replyTriggersDetail: boolean;
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
  /** When this recipient first wrote back to the report (a real inbound WhatsApp message), or null. Independent of delivery. */
  repliedAt: string | null;
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
  /** The Shopify Orders Summary template (aayushwellness_daily_team_report_3): its {{1}}..{{5}} mapping and whether Meta has made it available. Read-only status. */
  summaryTemplate: SummaryTemplateStatus;
  /** The template the saved automation uses today: can it be sent right now, and what does it send? null = none saved. */
  selectedTemplate: SelectedTemplateStatus | null;
}

export type SummaryTemplateState = "NOT_ADDED" | "NOT_APPROVED" | "VARIABLES_MISMATCH" | "READY";
export interface SummaryTemplateStatus {
  name: string;
  state: SummaryTemplateState;
  /** Meta's status as synced (APPROVED / PENDING / REJECTED / DISABLED / DRAFT); null when it is not in the CRM. */
  status: string | null;
  language: string | null;
  provider: string | null;
  reason: string;
  /** Is it the template the saved automation currently uses? */
  selected: boolean;
  mapping: { position: number; variable: string; meaning: string }[];
}
export type SummaryKind = "SHOPIFY_SUMMARY" | "WEBSITE_ABANDONED" | "REPORT_TEXT" | "UNKNOWN";
export interface SelectedTemplateStatus {
  name: string;
  language: string | null;
  usable: boolean;
  reason: string | null;
  sends: SummaryKind;
}

export interface ReportDeliveryPage {
  items: ReportDelivery[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

export type ScheduledPhase = "CANCELLED" | "SCHEDULED" | "PROCESSING" | "WAITING_FOR_REPLY" | "PARTIALLY_SENT" | "SENT" | "FAILED";
export type ScheduledFormat = "NOTIFICATION" | "DETAIL" | "EXCEL";
export interface ScheduledRow {
  key: string;
  /** When the report is (or was) SENT - an instant; show it in `timezone`. */
  scheduledAt: string;
  timezone: string;
  /** Which days' figures it covers - a different thing from scheduledAt. */
  dataFrom: string;
  dataTo: string;
  recipientName: string | null;
  recipientPhone: string;
  templateName: string | null;
  languageCode: string;
  formats: ScheduledFormat[];
  status: ScheduledPhase;
  statusLabel: string;
  kind?: "SCHEDULED" | "TEST";
  utcOffset?: string;
  nextExecutionAt?: string;
  lastAttemptAt?: string | null;
  parts?: { notification: string; detail: string; excel: string };
  /** Upcoming rows: the occurrence a Cancel acts on (the whole occurrence, all recipients). */
  occurrenceDate?: string;
  canCancel?: boolean;
  /** Recent rows. */
  runId?: string;
  canDelete?: boolean;
  deleteBlockedReason?: string | null;
  sentAny?: boolean;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
}
export interface ReportScheduled {
  timezone: string;
  enabled: boolean;
  recurring: { sendTime: string; timezone: string; reportFor: string; dataDate: string | null } | null;
  oneTimeSupported: boolean;
  cancelSupported: boolean;
  upcoming: ScheduledRow[];
  /** Future occurrences already cancelled (they never appear in `upcoming`). */
  cancelledUpcoming: { runId: string; scheduledAt: string; timezone: string; dataFrom: string; dataTo: string; cancelledAt: string | null; cancelledBy: string | null }[];
  recent: ScheduledRow[];
  reason: string | null;
}

/** The exact figures one report run sent in its initial message, frozen at generation time (never changes), with that run's CURRENT delivery state. */
export interface ReportSnapshot {
  id: string;
  runId: string;
  kind: "SCHEDULED" | "TEST";
  reportDate: string;
  reportFrom: string;
  timezone: string;
  templateName: string | null;
  generatedAt: string;
  /** The template values exactly as sent. */
  values: Record<string, string>;
  figures: {
    /** The complete Shopify order set (website + telecaller-created), for snapshots taken with the Shopify Orders Summary template. Absent on older snapshots. */
    shopify?: { totalOrders: number; websiteOrders: number; telecallerOrders: number; totalRevenue: number } | null;
    website: { totalOrders: number; totalRevenue: number; codOrders: number; prepaidOrders: number; otherOrders?: number } | null;
    abandoned: { totalLeads: number; ordersConverted: number; revenue: number; codOrders: number; prepaidOrders: number } | null;
  };
  runStatus: string;
  deliveries: { name: string | null; phone: string; status: ReportRecipientStatus; providerMessageId: string | null; sentAt: string | null; deliveredAt: string | null; readAt: string | null; error: string | null }[];
}
export interface ReportSnapshotPage {
  items: ReportSnapshot[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

/** Live tracking of one report run: the selectable runs (newest first) and the chosen run with every recipient's stored delivery and reply state. */
export interface ReportTracking {
  runs: { id: string; kind: "SCHEDULED" | "TEST"; reportDate: string; reportFrom: string; scheduledFor: string }[];
  run: ReportDelivery | null;
}

/** The exact figures one report run sent in its initial message, frozen at generation time (never changes), with that run's CURRENT delivery state. */
export interface ReportSnapshot {
  id: string;
  runId: string;
  kind: "SCHEDULED" | "TEST";
  reportDate: string;
  reportFrom: string;
  timezone: string;
  templateName: string | null;
  generatedAt: string;
  /** The template values exactly as sent. */
  values: Record<string, string>;
  figures: {
    /** The complete Shopify order set (website + telecaller-created), for snapshots taken with the Shopify Orders Summary template. Absent on older snapshots. */
    shopify?: { totalOrders: number; websiteOrders: number; telecallerOrders: number; totalRevenue: number } | null;
    website: { totalOrders: number; totalRevenue: number; codOrders: number; prepaidOrders: number; otherOrders?: number } | null;
    abandoned: { totalLeads: number; ordersConverted: number; revenue: number; codOrders: number; prepaidOrders: number } | null;
  };
  runStatus: string;
  deliveries: { name: string | null; phone: string; status: ReportRecipientStatus; providerMessageId: string | null; sentAt: string | null; deliveredAt: string | null; readAt: string | null; error: string | null }[];
}
export interface ReportSnapshotPage {
  items: ReportSnapshot[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}
