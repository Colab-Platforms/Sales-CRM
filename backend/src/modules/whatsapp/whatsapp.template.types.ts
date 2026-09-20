import type { WhatsAppProviderName, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";

export interface CreateTemplateInput {
  name: string;
  provider: WhatsAppProviderName;
  category?: string;
  language: string;
  body: string;
}

// status here is deliberately narrower than WhatsAppTemplateStatus - see whatsapp.template.service.ts's
// updateTemplate: only DRAFT/DISABLED are ever settable by a person, PENDING/APPROVED/REJECTED only
// ever come from a real provider sync.
export interface UpdateTemplateInput {
  name?: string;
  category?: string;
  language?: string;
  body?: string;
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
  status: WhatsAppTemplateStatus;
  quality: string | null;
  lastSyncedAt: Date | null;
  createdBy: { id: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
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

export interface TemplateSyncSummary {
  provider: WhatsAppProviderName;
  supported: boolean;
  reason?: string;
  created: number;
  updated: number;
  unchanged: number;
  total: number;
}
