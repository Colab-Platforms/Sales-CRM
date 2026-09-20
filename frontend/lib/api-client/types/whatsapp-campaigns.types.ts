// Kept in sync with backend/src/modules/whatsapp/whatsapp.campaign.types.ts.
import type { CustomerListItem } from "./customers.types";

export type WhatsAppCampaignStatus = "DRAFT" | "SCHEDULED" | "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED";
export type WhatsAppCampaignRecipientStatus = "PENDING" | "CLAIMED" | "SENT" | "SKIPPED" | "FAILED";

// The exact same filter vocabulary CustomersFilters (components/customers/customers-filters.tsx)
// already uses - a campaign's audience filters are that component reused, not a second one.
export interface AudienceFilters {
  search?: string;
  segment?: string;
  ownerId?: string;
  hasOrders?: boolean;
  paymentStatus?: string;
  shipmentStatus?: string;
  dateFrom?: string;
  dateTo?: string;
  nbaAction?: string;
  nbaPriority?: string;
}

export interface CreateCampaignInput {
  name: string;
  description?: string;
  templateId: string;
  filters: AudienceFilters;
}

export interface UpdateCampaignInput {
  name?: string;
  description?: string;
  templateId?: string;
  filters?: AudienceFilters;
}

export interface LaunchCampaignInput {
  scheduledAt?: string;
}

export interface CampaignStats {
  totalRecipients: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  pending: number;
}

export interface CampaignSummary {
  id: string;
  name: string;
  description: string | null;
  status: WhatsAppCampaignStatus;
  template: { id: string; name: string; status: string } | null;
  createdBy: { id: string; name: string } | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  stats: CampaignStats;
}

export interface CampaignDetail extends CampaignSummary {
  filters: AudienceFilters;
}

export interface AudiencePreview {
  count: number;
  sample: CustomerListItem[];
  excludedNoMobile: number;
}

export interface ListCampaignsParams {
  page: number;
  pageSize: number;
  status?: WhatsAppCampaignStatus;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface CampaignListResult {
  items: CampaignSummary[];
  pagination: Pagination;
}

export interface ListCampaignRecipientsParams {
  page: number;
  pageSize: number;
  status?: WhatsAppCampaignRecipientStatus;
}

export interface CampaignRecipientView {
  id: string;
  customer: { leadId: string; name: string; mobile: string | null };
  status: WhatsAppCampaignRecipientStatus;
  failureReason: string | null;
  attemptedAt: string | null;
  message: {
    id: string;
    status: string;
    body: string | null;
    sentAt: string | null;
    deliveredAt: string | null;
    readAt: string | null;
    failedAt: string | null;
    errorMessage: string | null;
  } | null;
}

export interface CampaignRecipientListResult {
  items: CampaignRecipientView[];
  pagination: Pagination;
}
