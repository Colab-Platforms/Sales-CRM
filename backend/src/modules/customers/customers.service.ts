import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { InterestedPeriodStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
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
  CustomerListResult,
  CustomerTimelineResult,
  ListCustomerTimelineQuery,
  ListCustomersQuery,
  NextBestActionInfo,
} from "./customers.types.js";

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

  async getCustomer360(user: AuthUser, leadId: string): Promise<Customer360> {
    const leadScope = await getLeadScope(user, this.db);
    const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(leadId, leadScope), select: PROFILE_SELECT });

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

    return {
      profile: mapProfile(lead),
      segment,
      nextBestAction: buildNbaInfo(orders, segment, paymentSummary),
      paymentSummary,
      latestOrder: orderSummaries[0] ?? null,
      currentOrderStatus: orderSummaries[0]?.status ?? null,
      orders: orderSummaries,
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
  // filtered/sorted/paginated in memory. Acceptable at today's scale; would need a materialized
  // column if the customer base grows by orders of magnitude.
  async listCustomers(user: AuthUser, query: ListCustomersQuery): Promise<CustomerListResult> {
    const leadScope = await getLeadScope(user, this.db);
    const where = buildCustomerListWhere(query, leadScope);

    const leads = await this.db.lead.findMany({
      where,
      select: { ...CUSTOMER_LIST_SELECT, orders: { select: ORDER_SUMMARY_SELECT, orderBy: [{ createdAt: "desc" }, { id: "desc" }] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    let items = leads.map((lead) =>
      mapCustomerListItem({ ...lead, hasActiveInterestedPeriod: lead.interestedPeriods.length > 0 }, lead.orders),
    );

    if (query.hasOrders !== undefined) items = items.filter((c) => (query.hasOrders ? c.orderCount > 0 : c.orderCount === 0));
    if (query.segment) items = items.filter((c) => c.segment === query.segment);
    if (query.paymentStatus) {
      items = items.filter((c) => (query.paymentStatus === "NONE" ? c.currentPaymentStatus === null : c.currentPaymentStatus === query.paymentStatus));
    }
    if (query.shipmentStatus) items = items.filter((c) => c.currentShipmentStatus === query.shipmentStatus);
    if (query.nbaAction) items = items.filter((c) => c.nbaAction === query.nbaAction);
    if (query.nbaPriority) items = items.filter((c) => c.nbaPriority === query.nbaPriority);

    // Most recently active customers first; customers with no order yet sort last.
    items.sort((a, b) => (b.lastOrderAt?.getTime() ?? 0) - (a.lastOrderAt?.getTime() ?? 0));

    const totalItems = items.length;
    const start = (query.page - 1) * query.pageSize;
    const page = items.slice(start, start + query.pageSize);

    return {
      items: page,
      pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) },
    };
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
}

export default CustomersService;
