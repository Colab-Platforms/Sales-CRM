import type { CustomerListItem, ListCustomersQuery } from "../customers/customers.types.js";

// Reuses E6.7's own audience-filter vocabulary verbatim (see CustomersService.resolveMatchingCustomers)
// - never a second segmentation engine. Only page/pageSize are dropped: a campaign's audience is
// always resolved in full (bounded by the recipient-creation step itself), not paginated.
export type AudienceFilters = Omit<ListCustomersQuery, "page" | "pageSize">;

export type WhatsAppCampaignStatus = "DRAFT" | "SCHEDULED" | "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED";
export type WhatsAppCampaignRecipientStatus = "PENDING" | "CLAIMED" | "SENT" | "SKIPPED" | "FAILED";

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
  /** Omit (or leave in the past) to send now; a future timestamp schedules it instead. */
  scheduledAt?: Date;
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

export interface ListCampaignsQuery {
  page: number;
  pageSize: number;
  status?: WhatsAppCampaignStatus;
}

export interface CampaignListResult {
  items: CampaignSummary[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

export interface ListCampaignRecipientsQuery {
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
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}
