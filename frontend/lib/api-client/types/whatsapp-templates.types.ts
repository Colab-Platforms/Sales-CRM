// Kept in sync with backend/src/modules/whatsapp/whatsapp.template.types.ts.

export type WhatsAppProvider = "AISENSY" | "GUPSHUP" | "META";
export type WhatsAppTemplateStatus = "DRAFT" | "PENDING" | "APPROVED" | "REJECTED" | "DISABLED";

export type TemplateHeaderType = "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
export interface TemplateHeader {
  type: TemplateHeaderType;
  text?: string;
  mediaUrl?: string;
}

export type TemplateButtonType = "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
export interface TemplateButton {
  type: TemplateButtonType;
  text: string;
  url?: string;
  dynamic?: boolean;
  phoneNumber?: string;
}

export interface TemplateComponents {
  header?: TemplateHeader;
  footer?: string;
  buttons?: TemplateButton[];
  bodyExamples?: Record<string, string>;
}

export interface TemplateUsage {
  campaigns: number;
  automationConfigs: number;
  messages: number;
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  provider: WhatsAppProvider;
  providerTemplateId: string | null;
  externalId: string | null;
  category: string | null;
  language: string;
  body: string;
  variables: string[];
  components: TemplateComponents | null;
  status: WhatsAppTemplateStatus;
  quality: string | null;
  lastSyncedAt: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  /** Only present on the detail view (getTemplate), never in a list row. */
  usage?: TemplateUsage;
}

export interface ListTemplatesParams {
  page: number;
  pageSize: number;
  search?: string;
  provider?: WhatsAppProvider;
  status?: WhatsAppTemplateStatus;
  category?: string;
  language?: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface TemplateListResult {
  items: WhatsAppTemplate[];
  pagination: Pagination;
}

export interface CreateTemplateInput {
  name: string;
  provider: WhatsAppProvider;
  category?: string;
  language: string;
  body: string;
  components?: TemplateComponents;
}

export interface UpdateTemplateInput {
  name?: string;
  category?: string;
  language?: string;
  body?: string;
  components?: TemplateComponents | null;
  status?: "DRAFT" | "DISABLED";
}

export interface TemplateSyncSummary {
  provider: WhatsAppProvider;
  supported: boolean;
  reason?: string;
  created: number;
  updated: number;
  unchanged: number;
  /** Previously-synced templates no longer reported at all by the provider (deleted there) - marked DISABLED
   *  locally rather than left however they last were. */
  disabledMissing: number;
  total: number;
}

export interface DeleteTemplateResult {
  id: string;
  deleted: true;
}
