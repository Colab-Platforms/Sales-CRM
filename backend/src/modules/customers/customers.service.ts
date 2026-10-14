import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, InterestedPeriodStatus, LeadWorkingStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { canViewAllWhatsAppConversations } from "../whatsapp/whatsapp.history.filters.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { statusForRole } from "@/lib/leadStatusView.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig, ShopifyConfigError } from "../shopify/shopify.config.js";
import { findCustomerByContact, type NormalizedCustomerListItem } from "../shopify/shopify.customers.js";
import { getLiveTrackingBatch } from "../shiprocket/shiprocket.live-tracking.js";
import {
  buildCustomerListWhere,
  buildNbaInfo,
  buildPaymentSummary,
  buildSegmentInfo,
  mapCustomerListItem,
  mapOrderSummary,
  mapProfile,
  scopedLeadWhere,
} from "./customers.filters.js";
import {
  buildAbandonmentEntries,
  buildAssignmentEntries,
  buildCallEntries,
  buildInterestedEntries,
  buildLeadCreatedEntry,
  buildOrderEntries,
  buildRecoveryEntries,
  buildTaskEntries,
  buildWhatsAppEntries,
  sortTimelineDesc,
} from "./customers.timeline.js";
import type {
  Customer360,
  CustomerDeactivationImpact,
  CustomerListResult,
  CustomerTimelineResult,
  ListCustomerTimelineQuery,
  ListCustomersQuery,
  NextBestActionInfo,
} from "./customers.types.js";

// Live Shopify customer overlay for Customer 360 - additive only, never replaces CRM-owned fields.
// Same in-process TTL Map idiom as orders.live.service.ts/orders.service.ts. Keyed by mobile+email
// together (not per-user - a Shopify customer match isn't RBAC-sensitive on its own; the caller
// already passed the CRM's own lead-scope check to load the lead in the first place).
interface ShopifyCustomerOverlayResult {
  customer: NormalizedCustomerListItem | null;
  error?: string;
}
const SHOPIFY_CUSTOMER_OVERLAY_TTL_MS = 60_000;
const shopifyCustomerOverlayCache = new Map<string, { value: ShopifyCustomerOverlayResult; expiresAt: number }>();

async function fetchShopifyCustomerOverlay(mobile: string | null, email: string | null): Promise<ShopifyCustomerOverlayResult> {
  if (!mobile && !email) return { customer: null };
  const cacheKey = `${mobile ?? ""}|${email ?? ""}`;

  const cached = shopifyCustomerOverlayCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let result: ShopifyCustomerOverlayResult;
  try {
    const client = new ShopifyClient(loadShopifyConfig());
    const customer = await findCustomerByContact(client, { mobile, email });
    result = { customer };
  } catch (error) {
    result = {
      customer: null,
      error: error instanceof ShopifyConfigError ? "Shopify is not configured" : "Could not reach Shopify for live customer details",
    };
  }

  shopifyCustomerOverlayCache.set(cacheKey, { value: result, expiresAt: Date.now() + SHOPIFY_CUSTOMER_OVERLAY_TTL_MS });
  return result;
}

// Active-interest is only ever needed as a boolean, so only enough rows to know "any?" are fetched.
const ACTIVE_INTERESTED_SELECT = {
  where: { status: InterestedPeriodStatus.ACTIVE },
  select: { id: true },
  take: 1,
} satisfies Prisma.Lead$interestedPeriodsArgs;

const PROFILE_SELECT = {
  id: true,
  leadNumber: true,
  firstName: true,
  lastName: true,
  mobile: true,
  email: true,
  workingStatus: true,
  priority: true,
  createdAt: true,
  lastActivityAt: true,
  lastContactedAt: true,
  source: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
  interestedPeriods: ACTIVE_INTERESTED_SELECT,
} satisfies Prisma.LeadSelect;

const CUSTOMER_LIST_SELECT = {
  id: true,
  leadNumber: true,
  firstName: true,
  lastName: true,
  mobile: true,
  workingStatus: true,
  owner: { select: { id: true, name: true } },
  interestedPeriods: ACTIVE_INTERESTED_SELECT,
} satisfies Prisma.LeadSelect;

// mapOrderSummary only ever reads shipments[0] (the latest), so only that one row is fetched - a
// safe, behavior-preserving bound (E6.9 QA: confirmed no order in the live DB currently has more
// than one shipment row, since Shopify sync upserts by externalId, but this also protects against
// an unbounded fetch if an order ever does get multiple parcels/fulfilments).
const SHIPMENT_SELECT = {
  select: {
    id: true,
    status: true,
    courier: true,
    trackingNumber: true,
    trackingUrl: true,
    shippedAt: true,
    expectedDeliveryAt: true,
    deliveredAt: true,
    returnedAt: true,
    createdAt: true,
  },
  orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  take: 1,
} satisfies Prisma.Order$shipmentsArgs;

const ORDER_SUMMARY_SELECT = {
  id: true,
  orderNumber: true,
  externalNumber: true,
  source: true,
  createdAt: true,
  currency: true,
  totalAmount: true,
  status: true,
  payments: { select: { status: true, method: true, amount: true, refundedAmount: true } },
  shipments: SHIPMENT_SELECT,
} satisfies Prisma.OrderSelect;

const ORDER_MILESTONE_SELECT = {
  id: true,
  orderNumber: true,
  externalNumber: true,
  status: true,
  createdAt: true,
  placedAt: true,
  confirmedAt: true,
  cancelledAt: true,
  shipments: { select: { id: true, courier: true, trackingNumber: true, shippedAt: true, deliveredAt: true, returnedAt: true } },
} satisfies Prisma.OrderSelect;

const ACTIVITY_SELECT = {
  id: true,
  type: true,
  referenceType: true,
  referenceId: true,
  orderId: true,
  title: true,
  description: true,
  createdAt: true,
  actor: { select: { id: true, name: true } },
} satisfies Prisma.ActivitySelect;

const ASSIGNMENT_SELECT = {
  id: true,
  assignmentType: true,
  assignedAt: true,
  user: { select: { id: true, name: true } },
  assignedBy: { select: { id: true, name: true } },
} satisfies Prisma.LeadAssignmentSelect;

const CALL_SELECT = {
  id: true,
  direction: true,
  status: true,
  startedAt: true,
  createdAt: true,
  durationSeconds: true,
  agent: { select: { id: true, name: true } },
  outcome: { select: { name: true } },
} satisfies Prisma.CallSelect;

const INTERESTED_SELECT = {
  id: true,
  startedAt: true,
  endedAt: true,
  status: true,
  qualifiedBy: { select: { id: true, name: true } },
} satisfies Prisma.InterestedLeadPeriodSelect;

const TASK_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  scheduledAt: true,
  completedAt: true,
  createdAt: true,
  assignedTo: { select: { id: true, name: true } },
} satisfies Prisma.TaskSelect;

const ABANDONMENT_SELECT = {
  id: true,
  type: true,
  detectedAt: true,
  status: true,
  recoveredAt: true,
} satisfies Prisma.AbandonmentSelect;

const RECOVERY_SELECT = {
  id: true,
  type: true,
  status: true,
  createdAt: true,
  completedAt: true,
  performedBy: { select: { id: true, name: true } },
} satisfies Prisma.RecoveryActionSelect;

// E7.1/E7.3: same shape whatsapp.service.ts's MESSAGE_SELECT uses for its own reads, trimmed to
// just what buildWhatsAppEntries needs.
const WHATSAPP_SELECT = {
  id: true,
  direction: true,
  provider: true,
  templateName: true,
  body: true,
  errorMessage: true,
  sentAt: true,
  deliveredAt: true,
  readAt: true,
  failedAt: true,
  receivedAt: true,
  sentBy: { select: { id: true, name: true } },
} satisfies Prisma.WhatsAppMessageSelect;

class CustomersService {
  constructor(private readonly db: DbClient = prisma) {}

  /**
   * `inboxRead` is the WhatsApp Inbox's READ-ONLY view of a customer: ADMIN, MANAGER and SALESPERSON (telecaller) may read the details and orders of ANY customer that has a WhatsApp
   * conversation, whichever team owns it (the same company-wide visibility the Inbox has). A customer outside the caller's normal scope comes back with `readOnly: true` so the UI offers
   * no edit/order/delete actions - and every one of those actions still checks the caller's scope on the server, so reading never grants a write. Without `inboxRead` (Customer 360 page,
   * everything else) nothing changes: out-of-scope customers look the same as missing ones.
   */
  async getCustomer360(user: AuthUser, leadId: string, opts: { inboxRead?: boolean } = {}): Promise<Customer360> {
    const leadScope = await getLeadScope(user, this.db);
    let lead = await this.db.lead.findFirst({ where: scopedLeadWhere(leadId, leadScope), select: PROFILE_SELECT });
    let readOnly = false;
    if (!lead && opts.inboxRead && canViewAllWhatsAppConversations(user.role)) {
      lead = await this.db.lead.findFirst({ where: { id: leadId, whatsAppMessages: { some: {} } }, select: PROFILE_SELECT });
      readOnly = Boolean(lead);
    }

    // Out-of-scope customers look the same as missing ones so ids can't be probed.
    if (!lead) {
      throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);
    }

    const orders = await this.db.order.findMany({
      where: { leadId },
      select: ORDER_SUMMARY_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const orderSummaries = orders.map(mapOrderSummary);
    const paymentSummary = buildPaymentSummary(orders);
    const segment = buildSegmentInfo(lead, lead.interestedPeriods.length > 0, orders, paymentSummary);

    // Independent of each other and of everything above (the CRM's own data is already assembled) -
    // fetch in parallel rather than sequentially, and let either fail on its own.
    const awbsToTrack = [...new Set(orderSummaries.map((o) => o.latestShipment?.trackingNumber).filter((awb): awb is string => Boolean(awb)))];
    const [shopifyOverlay, liveTrackingByAwb] = await Promise.all([
      fetchShopifyCustomerOverlay(lead.mobile, lead.email),
      awbsToTrack.length > 0 ? getLiveTrackingBatch(awbsToTrack) : Promise.resolve(new Map()),
    ]);
    for (const summary of orderSummaries) {
      const awb = summary.latestShipment?.trackingNumber;
      if (awb && summary.latestShipment) summary.latestShipment.liveTracking = liveTrackingByAwb.get(awb);
    }

    return {
      // A salesperson never sees ASSIGNED (shown as NEW).
      profile: { ...mapProfile(lead), workingStatus: statusForRole(lead.workingStatus, user.role) },
      segment,
      nextBestAction: buildNbaInfo(orders, segment, paymentSummary),
      paymentSummary,
      latestOrder: orderSummaries[0] ?? null,
      currentOrderStatus: orderSummaries[0]?.status ?? null,
      orders: orderSummaries,
      shopifyCustomer: shopifyOverlay.customer,
      shopifyError: shopifyOverlay.error,
      ...(readOnly ? { readOnly: true } : {}),
    };
  }

  // E6.8: the customer's Next Best Action alone (GET /api/customers/:leadId/next-best-action) -
  // reuses the exact same data/derivation as Customer 360's `nextBestAction` field, just without the
  // rest of the payload, for a caller that only needs the recommendation.
  async getNextBestAction(user: AuthUser, leadId: string): Promise<NextBestActionInfo> {
    const leadScope = await getLeadScope(user, this.db);
    const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(leadId, leadScope), select: PROFILE_SELECT });

    if (!lead) {
      throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);
    }

    const orders = await this.db.order.findMany({
      where: { leadId },
      select: ORDER_SUMMARY_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const paymentSummary = buildPaymentSummary(orders);
    const segment = buildSegmentInfo(lead, lead.interestedPeriods.length > 0, orders, paymentSummary);
    return buildNbaInfo(orders, segment, paymentSummary);
  }

  // E6.7 customer list: derives each matching lead's segment and post-sale state from the same
  // helpers Customer 360 uses. Segment/order-count/payment/shipment state are not database columns,
  // so - like the reconciliation module - matching leads (already narrowed by scope, owner, date
  // range and search at the database level) are fetched with their orders in ONE query, derived and
  // filtered/sorted in memory (resolveMatchingCustomers), then paginated here. Acceptable at
  // today's scale; would need a materialized column if the customer base grows by orders of magnitude.
  //
  // E7.7 reuses resolveMatchingCustomers directly as its audience-resolution engine (see
  // whatsapp.campaign.service.ts) - the exact same scope/filter/segment logic, never a second
  // customer-segmentation engine, and RBAC (a salesperson's campaign audience is already narrowed
  // to their own leads) falls out of the same getLeadScope() call this list already makes.
  async listCustomers(user: AuthUser, query: ListCustomersQuery): Promise<CustomerListResult> {
    const items = await this.resolveMatchingCustomers(user, query);

    const totalItems = items.length;
    const start = (query.page - 1) * query.pageSize;
    const page = items.slice(start, start + query.pageSize);

    return {
      items: page,
      pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) },
    };
  }

  /** Every customer matching these filters, within the caller's RBAC scope - sorted, not paginated. */
  async resolveMatchingCustomers(user: AuthUser, filters: Omit<ListCustomersQuery, "page" | "pageSize">): Promise<CustomerListResult["items"]> {
    const leadScope = await getLeadScope(user, this.db);
    const where = buildCustomerListWhere(filters, leadScope);

    const leads = await this.db.lead.findMany({
      where,
      select: { ...CUSTOMER_LIST_SELECT, orders: { select: ORDER_SUMMARY_SELECT, orderBy: [{ createdAt: "desc" }, { id: "desc" }] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    let items = leads.map((lead) =>
      mapCustomerListItem({ ...lead, hasActiveInterestedPeriod: lead.interestedPeriods.length > 0 }, lead.orders),
    );

    if (filters.hasOrders !== undefined) items = items.filter((c) => (filters.hasOrders ? c.orderCount > 0 : c.orderCount === 0));
    if (filters.segment) items = items.filter((c) => c.segment === filters.segment);
    if (filters.paymentStatus) {
      items = items.filter((c) => (filters.paymentStatus === "NONE" ? c.currentPaymentStatus === null : c.currentPaymentStatus === filters.paymentStatus));
    }
    if (filters.shipmentStatus) items = items.filter((c) => c.currentShipmentStatus === filters.shipmentStatus);
    if (filters.nbaAction) items = items.filter((c) => c.nbaAction === filters.nbaAction);
    if (filters.nbaPriority) items = items.filter((c) => c.nbaPriority === filters.nbaPriority);

    // Most recently active customers first; customers with no order yet sort last.
    items.sort((a, b) => (b.lastOrderAt?.getTime() ?? 0) - (a.lastOrderAt?.getTime() ?? 0));
    return items;
  }

  async getTimeline(user: AuthUser, leadId: string, query: ListCustomerTimelineQuery): Promise<CustomerTimelineResult> {
    const leadScope = await getLeadScope(user, this.db);
    const lead = await this.db.lead.findFirst({
      where: scopedLeadWhere(leadId, leadScope),
      select: { id: true, createdAt: true },
    });

    if (!lead) {
      throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);
    }

    // One indexed query per source table, none of them scaling with how much data the rest of
    // the database holds - safe to run while the Shopify backfill keeps inserting elsewhere.
    const [activities, orders, assignments, calls, interestedPeriods, tasks, abandonments, recoveryActions, whatsAppMessages] =
      await Promise.all([
        this.db.activity.findMany({ where: { leadId }, select: ACTIVITY_SELECT }),
        this.db.order.findMany({ where: { leadId }, select: ORDER_MILESTONE_SELECT }),
        this.db.leadAssignment.findMany({ where: { leadId }, select: ASSIGNMENT_SELECT }),
        this.db.call.findMany({ where: { leadId }, select: CALL_SELECT }),
        this.db.interestedLeadPeriod.findMany({ where: { leadId }, select: INTERESTED_SELECT }),
        this.db.task.findMany({ where: { leadId }, select: TASK_SELECT }),
        this.db.abandonment.findMany({ where: { leadId }, select: ABANDONMENT_SELECT }),
        this.db.recoveryAction.findMany({ where: { leadId }, select: RECOVERY_SELECT }),
        this.db.whatsAppMessage.findMany({ where: { leadId }, select: WHATSAPP_SELECT }),
      ]);

    const entries = sortTimelineDesc([
      buildLeadCreatedEntry(lead),
      ...buildAssignmentEntries(assignments),
      ...buildCallEntries(calls),
      ...buildInterestedEntries(interestedPeriods),
      ...buildTaskEntries(tasks),
      ...buildAbandonmentEntries(abandonments),
      ...buildRecoveryEntries(recoveryActions),
      ...buildOrderEntries(orders, activities),
      ...buildWhatsAppEntries(whatsAppMessages),
    ]);

    const totalItems = entries.length;
    const start = (query.page - 1) * query.pageSize;
    const pageEntries = entries.slice(start, start + query.pageSize);

    return {
      leadId: lead.id,
      entries: pageEntries,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / query.pageSize)),
      },
    };
  }

  // Part 8 (WhatsApp Inbox, Delete Customer): counts of what a hard delete would have touched - shown
  // in the confirmation dialog so the person deactivating this profile knows exactly what stays
  // intact. Never deleted: Lead has no cascading FK from any of these tables (orders, conversations,
  // messages, campaign recipients all reference it), so a real DELETE would fail at the database
  // level anyway - this is why deactivateCustomer below is a status change, not a delete.
  async getDeactivationImpact(user: AuthUser, leadId: string): Promise<CustomerDeactivationImpact> {
    const leadScope = await getLeadScope(user, this.db);
    const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(leadId, leadScope), select: { id: true } });
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);

    const [orders, conversations, messages, campaignRecipients] = await Promise.all([
      this.db.order.count({ where: { leadId } }),
      this.db.whatsAppConversation.count({ where: { leadId } }),
      this.db.whatsAppMessage.count({ where: { leadId } }),
      this.db.whatsAppCampaignRecipient.count({ where: { leadId } }),
    ]);

    return { orders, conversations, messages, campaignRecipients };
  }

  // Deactivates (never deletes) a customer profile. Sets Lead.workingStatus to DEACTIVATED - the one
  // new enum value added for this - which every existing "active leads" list/assignment query already
  // excludes by construction (they filter for the working statuses they actually want, and none of
  // them enumerate DEACTIVATED). Orders, conversations, messages, campaign history and every other
  // related record are left completely untouched; only this one status column changes.
  async deactivateCustomer(user: AuthUser, leadId: string): Promise<{ leadId: string; workingStatus: LeadWorkingStatus }> {
    const leadScope = await getLeadScope(user, this.db);
    const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(leadId, leadScope), select: { id: true, workingStatus: true } });
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);
    if (lead.workingStatus === LeadWorkingStatus.DEACTIVATED) return { leadId: lead.id, workingStatus: LeadWorkingStatus.DEACTIVATED };

    await this.db.lead.update({ where: { id: lead.id }, data: { workingStatus: LeadWorkingStatus.DEACTIVATED } });
    await this.db.activity.create({
      data: {
        leadId: lead.id,
        actorId: user.id,
        actorRole: user.role,
        type: ActivityType.STATUS_CHANGE,
        source: ActivitySource.USER,
        title: "Customer profile deactivated",
        description: "Deactivated from the WhatsApp Inbox. Orders, conversations and messages were not deleted.",
      },
    });

    return { leadId: lead.id, workingStatus: LeadWorkingStatus.DEACTIVATED };
  }
}

export default CustomersService;
