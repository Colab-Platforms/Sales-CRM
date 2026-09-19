import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { buildPaymentSummary, mapOrderSummary, mapProfile, scopedLeadWhere } from "./customers.filters.js";
import {
  buildAbandonmentEntries,
  buildAssignmentEntries,
  buildCallEntries,
  buildInterestedEntries,
  buildLeadCreatedEntry,
  buildOrderEntries,
  buildRecoveryEntries,
  buildTaskEntries,
  sortTimelineDesc,
} from "./customers.timeline.js";
import type { Customer360, CustomerTimelineResult, ListCustomerTimelineQuery } from "./customers.types.js";

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
} satisfies Prisma.LeadSelect;

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
} satisfies Prisma.OrderSelect;

const ACTIVITY_SELECT = {
  id: true,
  type: true,
  referenceType: true,
  referenceId: true,
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

    return {
      profile: mapProfile(lead),
      paymentSummary: buildPaymentSummary(orders),
      latestOrder: orderSummaries[0] ?? null,
      currentOrderStatus: orderSummaries[0]?.status ?? null,
      orders: orderSummaries,
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
    const [activities, orders, assignments, calls, interestedPeriods, tasks, abandonments, recoveryActions] =
      await Promise.all([
        this.db.activity.findMany({ where: { leadId }, select: ACTIVITY_SELECT }),
        this.db.order.findMany({ where: { leadId }, select: ORDER_MILESTONE_SELECT }),
        this.db.leadAssignment.findMany({ where: { leadId }, select: ASSIGNMENT_SELECT }),
        this.db.call.findMany({ where: { leadId }, select: CALL_SELECT }),
        this.db.interestedLeadPeriod.findMany({ where: { leadId }, select: INTERESTED_SELECT }),
        this.db.task.findMany({ where: { leadId }, select: TASK_SELECT }),
        this.db.abandonment.findMany({ where: { leadId }, select: ABANDONMENT_SELECT }),
        this.db.recoveryAction.findMany({ where: { leadId }, select: RECOVERY_SELECT }),
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
