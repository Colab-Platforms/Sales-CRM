// Kept in sync with backend/src/modules/whatsapp/whatsapp.template.types.ts.

export type WhatsAppProvider = "AISENSY" | "GUPSHUP";
export type WhatsAppTemplateStatus = "DRAFT" | "PENDING" | "APPROVED" | "REJECTED" | "DISABLED";

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
  status: WhatsAppTemplateStatus;
  quality: string | null;
  lastSyncedAt: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
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
}

export interface UpdateTemplateInput {
  name?: string;
  category?: string;
  language?: string;
  body?: string;
  status?: "DRAFT" | "DISABLED";
}

export interface TemplateSyncSummary {
  provider: WhatsAppProvider;
  supported: boolean;
  reason?: string;
  created: number;
  updated: number;
  unchanged: number;
  total: number;
}
