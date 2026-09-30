import type { LeadPriority, LeadWorkingStatus } from "../../../generated/prisma/enums.js";

// Live Customers list (reads directly from Shopify - GET /customers/live). Cursor-paginated, never
// the whole customer base in one page. Same idea as orders.live.types.ts: a Shopify customer is the
// external identity; the CRM's own Lead (if already known by phone) is joined in afterwards for the
// CRM-owned fields (owner, working status, priority) this intentionally does not carry.

export interface LiveCustomersQuery {
  after?: string;
  first: number;
  search?: string;
}

export interface LiveCustomerListItem {
  /** CRM lead id when linked, otherwise the Shopify customer GID (still a stable React key). */
  id: string;
  /** Numeric Shopify customer id. */
  externalId: string;
  name: string;
  email: string | null;
  phone: string | null;
  numberOfOrders: number | null;
  amountSpent: { amount: string; currencyCode: string } | null;
  address: { city: string | null; province: string | null; country: string | null } | null;
  // CRM-owned overlay - null on a Shopify customer the CRM has no matching lead for yet.
  leadId: string | null;
  leadNumber: string | null;
  owner: { id: string; name: string } | null;
  workingStatus: LeadWorkingStatus | null;
  priority: LeadPriority | null;
  /** false = a Shopify customer with no matching CRM lead yet (ADMIN-only, see customers.live.service.ts). */
  linkedInCrm: boolean;
}

export interface LiveCustomerPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  endCursor: string | null;
}

export interface LiveCustomerListResult {
  items: LiveCustomerListItem[];
  pageInfo: LiveCustomerPageInfo;
  /** Shopify could not be reached at all - items is always [] when this is set. */
  error?: string;
  /** Shopify loaded, but the CRM-owned overlay (owner/lead) partially failed. */
  partialError?: string;
}
