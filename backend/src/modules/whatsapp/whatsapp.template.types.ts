import type { WhatsAppProviderName, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";

// Structured pieces of a real WhatsApp template the flat `body` string cannot hold. Stored in
// WhatsAppTemplate.components as-is; never executed, only displayed/previewed and, at a real send, mapped into
// whichever provider's own request shape (a job the send path - not this module - owns).
export type TemplateHeaderType = "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
export interface TemplateHeader {
  type: TemplateHeaderType;
  /** TEXT only - up to ~60 characters (Meta's own limit); never carries a variable here (deliberately kept simple). */
  text?: string;
  /** IMAGE/VIDEO/DOCUMENT only - a reference URL for the CRM's own record-keeping. The CRM has no file-hosting
   *  service of its own (see shopify.orders.write.ts's media-url comment for the same constraint elsewhere), so
   *  nothing is uploaded here - this is metadata a human uses when creating the real template in the provider's
   *  own dashboard/console, never something the CRM submits on its own. */
  mediaUrl?: string;
}

export type TemplateButtonType = "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
export interface TemplateButton {
  type: TemplateButtonType;
  text: string;
  /** URL only. May contain one {{1}}-style trailing variable if `dynamic` is true (Meta's own convention). */
  url?: string;
  dynamic?: boolean;
  /** PHONE_NUMBER only - E.164, validated server-side. */
  phoneNumber?: string;
}

export interface TemplateComponents {
  header?: TemplateHeader;
  footer?: string;
  buttons?: TemplateButton[];
  /** Example values for the body's {{name}} placeholders, keyed by name - shown in the live preview and useful
   *  context for whoever manually re-creates this template in the provider's own console. */
  bodyExamples?: Record<string, string>;
}

export interface CreateTemplateInput {
  name: string;
  provider: WhatsAppProviderName;
  category?: string;
  language: string;
  body: string;
  components?: TemplateComponents;
}

// status here is deliberately narrower than WhatsAppTemplateStatus - see whatsapp.template.service.ts's
// updateTemplate: only DRAFT/DISABLED are ever settable by a person, PENDING/APPROVED/REJECTED only
// ever come from a real provider sync.
export interface UpdateTemplateInput {
  name?: string;
  category?: string;
  language?: string;
  body?: string;
  components?: TemplateComponents | null;
  status?: "DRAFT" | "DISABLED";
}

export interface ListTemplatesQuery {
  page: number;
  pageSize: number;
  search?: string;
  provider?: WhatsAppProviderName;
  status?: WhatsAppTemplateStatus;
  category?: string;
  language?: string;
}

export interface TemplateUsage {
  campaigns: number;
  automationConfigs: number;
  messages: number;
}

export interface TemplateSummary {
  id: string;
  name: string;
  provider: WhatsAppProviderName;
  providerTemplateId: string | null;
  externalId: string | null;
  category: string | null;
  language: string;
  body: string;
  variables: string[];
  components: TemplateComponents | null;
  status: WhatsAppTemplateStatus;
  quality: string | null;
  lastSyncedAt: Date | null;
  createdBy: { id: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
  /** Only populated on getTemplate (the detail view) - never on the list, to avoid an N+1 count per row. */
  usage?: TemplateUsage;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface TemplateListResult {
  items: TemplateSummary[];
  pagination: Pagination;
}

export interface DeleteTemplateResult {
  id: string;
  deleted: true;
}

export interface TemplateSyncSummary {
  provider: WhatsAppProviderName;
  supported: boolean;
  reason?: string;
  created: number;
  updated: number;
  unchanged: number;
  /** Previously-synced templates for this provider the sync no longer sees at all (deleted at the provider) -
   *  marked DISABLED locally rather than silently left however they last were (e.g. still APPROVED). */
  disabledMissing: number;
  total: number;
}
