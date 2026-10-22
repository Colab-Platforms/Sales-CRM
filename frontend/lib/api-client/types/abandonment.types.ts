import type { Pagination } from "./orders.types";
import type { OrderStatus, PaymentMode, PaymentStatus, ShipmentStatus } from "./orders.types";
import type { LeadWorkingStatus } from "./dashboard.types";
import type { Call } from "./calling.types";
import type { LeadFollowUp } from "./tasks.types";

// The abandoned-leads queue ("/dashboard/abandoned-leads"), fed by Shiprocket Checkout's "Abandon
// Cart" webhook. Mirrors shiprocket.types.ts's shape (list item + summary + pagination) since it is
// the same kind of centralized operational queue as the Shiprocket shipments page.

export type AbandonmentType = "CHECKOUT" | "PAYMENT" | "SALES";
export type AbandonmentStatus = "ACTIVE" | "IN_PROGRESS" | "RECOVERED" | "NOT_RECOVERED" | "EXPIRED";
export type RecoveryActionType = "CALL" | "CALLBACK" | "CONTINUE_ORDER";
export type RecoveryActionStatus = "PENDING" | "IN_PROGRESS" | "SUCCESS" | "FAILED";

/** Which day(s) of abandoned checkouts to list - by when each was abandoned, days in IST (computed by the server). */
export type AbandonmentDateRange = "today" | "yesterday" | "all";

export type AbandonmentAssignmentFilter = "UNASSIGNED" | "ASSIGNED_TO_MANAGER" | "ASSIGNED_TO_SALESPERSON" | "UNASSIGNED_TELECALLER";

export interface ListAbandonmentsParams {
  page: number;
  pageSize: number;
  search?: string;
  status?: AbandonmentStatus;
  type?: AbandonmentType;
  dateFrom?: string;
  dateTo?: string;
  dateRange?: AbandonmentDateRange;
  assignment?: AbandonmentAssignmentFilter;
  managerId?: string;
  salespersonId?: string;
  workingStatus?: LeadWorkingStatus;
  /** Item keys from GET /abandonments/items; any of them (OR). */
  items?: string[];
  /** Table column filters (server-side, over the whole result set). */
  lead?: string;
  contact?: string;
  assignee?: string;
  lastAction?: "CALL" | "CALLBACK" | "CONTINUE_ORDER" | "NONE";
  valueMin?: number;
  valueMax?: number;
}

export interface AbandonmentSummary {
  total: number;
  active: number;
  inProgress: number;
  recovered: number;
  notRecovered: number;
  expired: number;
}

// Structured cart detail (value, items, checkout stage, resume link), as reported by the source at
// detection time. Null on abandonments recorded before this existed - the UI falls back to `summary`.
export interface CartSnapshot {
  cartValue: string | null;
  currency: string | null;
  itemCount: number | null;
  itemNames: string[];
  /** Per-line product/variant id, SKU, name and quantity. Empty on carts captured before this was stored. */
  items?: { productId: string | null; variantId: string | null; sku: string | null; name: string; quantity: number | null }[];
  stage: string | null;
  checkoutUrl: string | null;
}

export interface AbandonmentListItem {
  id: string;
  type: AbandonmentType;
  status: AbandonmentStatus;
  detectedAt: string;
  recoveredAt: string | null;
  priorityScore: string | null;
  priorityReason: string | null;
  /** Legacy free-text fallback for abandonments recorded before cartSnapshot existed. */
  summary: string | null;
  cartSnapshot: CartSnapshot | null;
  lead: {
    id: string;
    leadNumber: string;
    firstName: string;
    lastName: string | null;
    name: string;
    mobile: string | null;
    email: string | null;
    /** The lead's own pipeline status - separate from this abandonment's cart-recovery `status` above. */
    workingStatus: LeadWorkingStatus;
    assignedManager: { id: string; name: string } | null;
    owner: { id: string; name: string } | null;
    calls: Call[];
    tasks: LeadFollowUp[];
  };
  source: { id: string; name: string } | null;
  latestRecoveryAction: { type: RecoveryActionType; status: RecoveryActionStatus; createdAt: string } | null;
}

export interface ListAbandonmentsResult {
  items: AbandonmentListItem[];
  summary: AbandonmentSummary;
  pagination: Pagination;
}

export interface RecoveryActionItem {
  id: string;
  type: RecoveryActionType;
  status: RecoveryActionStatus;
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
  performedBy: { id: string; name: string } | null;
}

/** A delivery address as the customer entered it (every part optional); `formatted` is every available part in reading order. */
export interface AbandonmentAddress {
  name: string | null;
  phone: string | null;
  line1: string | null;
  line2: string | null;
  landmark: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;
  formatted: string;
}

/** One earlier order of the customer behind an abandoned lead (CRM-created or synced from Shopify). */
export interface CustomerOrderSummary {
  id: string;
  orderNumber: string;
  externalNumber: string | null;
  createdAt: string;
  totalAmount: string;
  currency: string;
  status: OrderStatus;
  paymentMode: PaymentMode | null;
  paymentStatus: PaymentStatus | null;
  fulfillmentStatus: ShipmentStatus | null;
  origin: "CRM" | "SHOPIFY";
  /** Free-text fulfilment state for an order known only from Shopify (no shipment row). */
  fulfillmentLabel?: string | null;
  tracking?: { number: string | null; company: string | null; url: string | null } | null;
  /** false = read live from the store and not a CRM order yet. */
  inCrm?: boolean;
}

export interface AbandonmentDetail extends AbandonmentListItem {
  reference: { referenceType: string | null; referenceId: string | null };
  recoveryActions: RecoveryActionItem[];
  addresses: {
    shipping: AbandonmentAddress | null;
    billing: AbandonmentAddress | null;
    /** Where `shipping` came from: the saved checkout, or the customer's latest order. */
    source: "CHECKOUT" | "LAST_ORDER" | null;
    /** The lead's short location text ("City, State"), shown only when nothing fuller exists. */
    leadLocation: string | null;
  };
  previousOrders: {
    total: number;
    items: CustomerOrderSummary[];
    /** What happened when the store (Shopify) was asked: OK = searched; NOT_CONFIGURED / UNAVAILABLE = could not be checked; AMBIGUOUS = several store customers match; NOT_CHECKED = not asked. */
    shopify: "OK" | "NOT_CONFIGURED" | "UNAVAILABLE" | "AMBIGUOUS" | "NOT_CHECKED";
    shopifyCustomerFound?: boolean;
    shopifyTruncated?: boolean;
    shopifyMatchCount?: number;
  };
}

export interface CreateRecoveryActionInput {
  type: RecoveryActionType;
  status?: RecoveryActionStatus;
  notes?: string;
}

export interface BulkAssignManagerPayload {
  abandonmentIds: string[];
  method: "MANUAL" | "ROUND_ROBIN";
  managerId?: string;
  managerIds?: string[];
}

export interface BulkAssignSalespersonPayload {
  abandonmentIds: string[];
  method: "MANUAL" | "ROUND_ROBIN";
  salespersonId?: string;
  salespersonIds?: string[];
}

export interface BulkUpdateLeadStatusPayload {
  abandonmentIds: string[];
  workingStatus: LeadWorkingStatus;
  /** Required when workingStatus is CALL_BACK or FOLLOW_UP; applied to every selected lead. */
  followUpAt?: string;
}

// Auto-assignment toggles behind the manual bulk-assign flow above - see
// backend/src/modules/lead/lead.service.ts's autoAssignAbandonedLead. The manager-stage toggle is
// global (admin-controlled); the salesperson-stage toggle is scoped to the logged-in manager's own team.
export interface AutoAssignConfig {
  enabled: boolean;
}

// Manager stage only: which managers are opted into the round robin. `managerIds` persists even
// while `enabled` is false, so re-opening the picker shows the last selection.
export interface ManagerAutoAssignConfig extends AutoAssignConfig {
  managerIds: string[];
}

/** The saved cart + address of ONE abandoned checkout, shaped for the Create Order form (GET /abandonments/:id/order-prefill). */
export interface OrderPrefillLine {
  key: string;
  productId: string | null;
  variantId: string | null;
  matched: boolean;
  name: string;
  variantTitle: string | null;
  sku: string | null;
  imageUrl: string | null;
  quantity: number;
  websiteUnitPrice: string | null;
}

export interface OrderPrefillAddress {
  name: string | null;
  phone: string | null;
  line1: string | null;
  line2: string | null;
  landmark: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;
  company: string | null;
  houseNumber?: string | null;
  building?: string | null;
  area?: string | null;
  street?: string | null;
  deliveryInstructions?: string | null;
}

export interface OrderPrefill {
  abandonmentId: string;
  leadId: string;
  dataFrom: "saved_cart" | "checkout_delivery" | "none";
  sourceName: string | null;
  capturedAt: string | null;
  stale: boolean;
  refreshSupported: false;
  currency: string;
  customer: { name: string | null; phone: string | null; email: string | null };
  addressKind: "shipping" | "billing" | null;
  address: OrderPrefillAddress | null;
  lines: OrderPrefillLine[];
  totals: { total: string | null; shipping: string | null; tax: string | null; discount: string | null; discountCodes: string[] };
  notes: string[];
}

/** One telecaller's row of the distribution dashboard. "Abandoned" counts follow when the checkout was abandoned; "assigned" counts follow when the CURRENT assignment was made. */
export interface DistributionTelecaller {
  userId: string;
  name: string;
  /** Currently assigned to this telecaller (all time). */
  totalAssigned: number;
  /** Currently assigned AND abandoned inside the selected period. */
  inPeriod: number;
  todayAbandoned: number;
  yesterdayAbandoned: number;
  /** Currently assigned and the assignment was made today / inside the selected period. */
  assignedToday: number;
  assignedInPeriod: number;
}

export interface AbandonmentDistribution {
  range: AbandonmentDateRange;
  timezone: string;
  summary: {
    total: number;
    assigned: number;
    unassigned: number;
    telecallersWithLeads: number;
    todayTotal: number;
    yesterdayTotal: number;
    unassignedAllTime: number;
  };
  telecallers: DistributionTelecaller[];
}

export interface TelecallerSummary {
  timezone: string;
  totalAssigned: number;
  today: number;
  yesterday: number;
  all: number;
  newlyAssignedToday: number;
}

export interface AssignableTelecaller {
  id: string;
  name: string;
  groupName?: string | null;
}

/** Fastrr ingestion health: counts and times only (the API never returns customer data or secrets). */
export interface IngestionStatus {
  period: AbandonmentDateRange;
  timezone: string;
  now: string;
  lastReceivedAt: string | null;
  lastProcessedAt: string | null;
  lastFailedAt: string | null;
  secondsSinceLastReceived: number | null;
  received: { events: number; distinctCarts: number };
  byStatus: { processed: number; ignoredNoContact: number; failed: number; pending: number };
  failed: { retryable: number; exhausted: number };
  processedAfterRetry: number;
  carts: { received: number; saved: number; notSaved: number; ignoredNoContact: number };
  latency: {
    providerToReceipt: { samples: number; p50: number | null; p90: number | null; max: number | null };
    receiptToSaved: { samples: number; p50: number | null; p90: number | null; max: number | null };
  };
  backlog: { pending: number; retryable: number; exhausted7d: number; oldestPendingAgeSeconds: number | null };
  process: { since: string; received: number; duplicates: number; unauthorized: number; invalidBody: number; notConfigured: number; unusableNoContact: number; processed: number; failedAttempts: number; exhausted: number; autoAssignFailed: number; recoveredByReconcile: number };
  lastReconcile: { at: string; examined: number; recovered: number; failedAgain: number; skipped: number } | null;
}

export interface IngestionReconcileResult {
  at: string;
  examined: number;
  recovered: number;
  failedAgain: number;
  skipped: number;
  remaining: number;
  timedOut: boolean;
}

