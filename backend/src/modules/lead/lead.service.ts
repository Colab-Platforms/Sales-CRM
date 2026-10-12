import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { generateLeadNumber } from "@/utils/leadNumber.js";
import { statusForRole } from "@/lib/leadStatusView.js";
import { FOLLOW_UP_TASK_TYPES, completePendingFollowUps, parseFollowUpAt, scheduleFollowUp } from "../tasks/tasks.followup.js";
// Root-cause fix: this used to import from @/utils/normalize.js, a second, DIFFERENT normalizeMobile
// that just strips non-digit characters - no "+" prefix, no default-country-code inference for a bare
// 10-digit number. Every lead ever created here (createLead - including the WhatsApp page's "Create
// Contact" - and createLeadFromSource, used by WhatsApp-inbound auto-creation, Shopify and Meta
// imports) got a normalizedMobile in that divergent shape, while whatsapp.matching.ts's
// matchSenderToLead has only ever matched against @/lib/leadIdentity.js's canonical "+"-prefixed
// form. That mismatch is what kept manufacturing brand-new "legacy-format" leads for this task's
// matching fix to work around - the matching-side patches were treating the symptom; this is the
// actual source. @/lib/leadIdentity.js is the one canonical phone/email identity function used
// everywhere else in the codebase (shopify.persist.ts, whatsapp.matching.ts, etc.) - this file now
// agrees with them, so a lead created here will always be found by the same lookup a WhatsApp reply
// (or a Shopify/Meta match) uses, with no special-casing needed on either side.
import { normalizeMobile, normalizeEmail } from "@/lib/leadIdentity.js";
import {
  Role,
  UserStatus,
  ImportBatchStatus,
  AssignmentType,
  ActivityType,
  TaskType,
  TaskStatus,
} from "../../../generated/prisma/enums.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { User, Lead } from "../../../generated/prisma/client.js";
import type { AuthUser } from "@/middlewares/auth.js";
import type {
  CreateLeadBody,
  UpdateLeadBody,
  ListLeadsQuery,
  BulkAssignManagerBody,
  BulkAssignSalespersonBody,
  BulkUpdateStatusBody,
} from "./lead.types.js";

type TxClient = Prisma.TransactionClient;

interface ParsedImportRow {
  firstName: string;
  lastName?: string;
  mobile?: string;
  normalizedMobile?: string;
  email?: string;
  normalizedEmail?: string;
  requirement?: string;
  location?: string;
  sourceName?: string;
}

interface ImportRowError {
  row: number;
  reason: string;
}

const leadListInclude = {
  source: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true, username: true } },
  assignedManager: { select: { id: true, name: true, username: true } },
  group: { select: { id: true, name: true } },
  importBatch: { select: { fileName: true, uploadedBy: { select: { id: true, name: true, role: true } } } },
  // The lead's pending call back / follow up reminder (at most one - scheduling a new one replaces it),
  // so the UI can show the time that's currently set and pre-fill it when rescheduling.
  tasks: {
    where: { status: TaskStatus.PENDING, type: { in: [...FOLLOW_UP_TASK_TYPES] } },
    select: { id: true, type: true, scheduledAt: true },
    orderBy: { scheduledAt: "asc" },
    take: 1,
  },
  calls: {
    select: {
      id: true,
      provider: true,
      direction: true,
      status: true,
      startedAt: true,
      answeredAt: true,
      endedAt: true,
      durationSeconds: true,
      recording: { select: { recordingUrl: true } },
      agent: { select: { id: true, name: true } },
      notes: true,
      outcome: { select: { id: true, name: true, code: true } },
    },
    orderBy: { createdAt: "desc" },
  },
} satisfies Prisma.LeadInclude;

class LeadService {
  // Salespersons see their calls (status, duration) but can't hear the recording —
  // only managers/admins can listen. Strip the URL out rather than the whole call.
  // They also never see the ASSIGNED status (shown as NEW), see statusForRole.
  private presentForRole<T extends { workingStatus: Lead["workingStatus"]; calls: { recording: { recordingUrl: string | null } | null }[] }>(
    entity: T,
    role: Role,
  ): T {
    if (role !== Role.SALESPERSON) return entity;
    return {
      ...entity,
      workingStatus: statusForRole(entity.workingStatus, role),
      calls: entity.calls.map((call) => (call.recording ? { ...call, recording: { recordingUrl: null } } : call)),
    };
  }

  private buildScopeWhere(user: AuthUser): Prisma.LeadWhereInput {
    if (user.role === Role.MANAGER) return { assignedManagerId: user.id };
    if (user.role === Role.SALESPERSON) return { ownerId: user.id };
    return {};
  }

  async listLeads(user: AuthUser, query: ListLeadsQuery) {
    const where: Prisma.LeadWhereInput = { ...this.buildScopeWhere(user) };

    if (query.sourceId) where.sourceId = query.sourceId;
    if (query.workingStatus) {
      const status = query.workingStatus as Lead["workingStatus"];
      // A salesperson's NEW includes leads that are ASSIGNED underneath; they can't filter on ASSIGNED itself.
      where.workingStatus =
        user.role === Role.SALESPERSON && (status === "NEW" || status === "ASSIGNED") ? { in: ["NEW", "ASSIGNED"] } : status;
    }
    where.lifecycleStage = query.lifecycleStage ?? "LEAD";
    // Cart-abandonment leads live only in the Abandoned Leads queue, never in the normal Leads list -
    // even once worked/recovered, so this excludes any lead with an Abandonment row.
    where.abandonments = { none: {} };

    if (query.assignment === "UNASSIGNED") {
      where.assignedManagerId = null;
    } else if (query.assignment === "ASSIGNED_TO_MANAGER") {
      where.assignedManagerId = { not: null };
      where.ownerId = null;
    } else if (query.assignment === "ASSIGNED_TO_SALESPERSON") {
      where.ownerId = { not: null };
    }

    if (user.role === Role.ADMIN && query.managerId) where.assignedManagerId = query.managerId;
    if (user.role !== Role.SALESPERSON && query.salespersonId) where.ownerId = query.salespersonId;

    if (query.search) {
      where.OR = [
        { firstName: { contains: query.search, mode: "insensitive" } },
        { lastName: { contains: query.search, mode: "insensitive" } },
        { mobile: { contains: query.search, mode: "insensitive" } },
        { email: { contains: query.search, mode: "insensitive" } },
        { leadNumber: { contains: query.search, mode: "insensitive" } },
      ];
    }

    const skip = (query.page - 1) * query.limit;

    const [data, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: leadListInclude,
        orderBy: { createdAt: "desc" },
        skip,
        take: query.limit,
      }),
      prisma.lead.count({ where }),
    ]);

    return {
      data: data.map((lead) => this.presentForRole(lead, user.role)),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  private async getLeadOrThrow(id: string) {
    const lead = await prisma.lead.findUnique({ where: { id }, include: leadListInclude });
    if (!lead) throw new ApiError("Lead not found", STATUS_CODES.NOT_FOUND);
    return lead;
  }

  private assertAccess(user: AuthUser, lead: Lead): void {
    if (user.role === Role.MANAGER && lead.assignedManagerId !== user.id) {
      throw new ApiError("Lead not found", STATUS_CODES.NOT_FOUND);
    }
    if (user.role === Role.SALESPERSON && lead.ownerId !== user.id) {
      throw new ApiError("Lead not found", STATUS_CODES.NOT_FOUND);
    }
  }

  async getLeadById(user: AuthUser, id: string) {
    const lead = await this.getLeadOrThrow(id);
    this.assertAccess(user, lead);
    return this.presentForRole(lead, user.role);
  }

  async createLead(user: AuthUser, data: CreateLeadBody) {
    const normalizedMobile = normalizeMobile(data.mobile);
    const normalizedEmail = normalizeEmail(data.email);

    let assignedManagerId: string | null = null;
    let ownerId: string | null = null;
    let groupId: string | null = null;

    if (user.role === Role.MANAGER) {
      assignedManagerId = user.id;
    } else if (user.role === Role.SALESPERSON) {
      ownerId = user.id;
      const membership = await prisma.groupMember.findFirst({
        where: { userId: user.id, isActive: true },
        include: { group: true },
      });
      if (membership) {
        groupId = membership.groupId;
        assignedManagerId = membership.group.managerId;
      }
    }

    const lead = await this.createLeadWithUniqueNumber({
      firstName: data.firstName,
      lastName: data.lastName,
      mobile: data.mobile,
      normalizedMobile,
      email: data.email,
      normalizedEmail,
      requirement: data.requirement,
      location: data.location,
      sourceId: data.sourceId,
      interestedProductId: data.interestedProductId,
      priority: data.priority,
      assignedManagerId,
      ownerId,
      groupId,
    });

    await prisma.activity.create({
      data: {
        leadId: lead.id,
        actorId: user.id,
        type: ActivityType.LEAD_CREATED,
        title: "Lead created",
      },
    });

    return lead;
  }

  private async createLeadWithUniqueNumber(
    data: Omit<Prisma.LeadUncheckedCreateInput, "leadNumber">,
    client: TxClient | typeof prisma = prisma,
  ) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await client.lead.create({ data: { ...data, leadNumber: generateLeadNumber() } });
      } catch (error: any) {
        if (error?.code === "P2002" && attempt < 4) continue;
        throw error;
      }
    }
    throw new ApiError("Failed to generate a unique lead number", STATUS_CODES.SERVER_ERROR);
  }

  async updateLead(user: AuthUser, id: string, data: UpdateLeadBody) {
    const lead = await this.getLeadOrThrow(id);
    this.assertAccess(user, lead);
    if (user.role === Role.SALESPERSON && data.workingStatus === "ASSIGNED") {
      throw new ApiError("Only a manager or admin can set a lead to Assigned", STATUS_CODES.FORBIDDEN);
    }
    // What this user currently sees; leaving it unchanged in the form must not overwrite the real status.
    const shownStatus = statusForRole(lead.workingStatus, user.role);

    const updateData: Prisma.LeadUpdateInput = {
      firstName: data.firstName,
      lastName: data.lastName,
      requirement: data.requirement,
      location: data.location,
      priority: data.priority,
    };

    if (data.mobile !== undefined) {
      updateData.mobile = data.mobile;
      updateData.normalizedMobile = normalizeMobile(data.mobile);
    }
    if (data.email !== undefined) {
      updateData.email = data.email;
      updateData.normalizedEmail = normalizeEmail(data.email);
    }
    if (data.sourceId !== undefined) updateData.source = { connect: { id: data.sourceId } };
    if (data.interestedProductId !== undefined) {
      updateData.interestedProduct = { connect: { id: data.interestedProductId } };
    }
    const statusChanged = data.workingStatus !== undefined && data.workingStatus !== shownStatus;
    if (statusChanged) updateData.workingStatus = data.workingStatus;

    // Call back / follow up always carry a reminder time: required when switching to one, and
    // accepted on its own to reschedule while the lead already has that status.
    const resultingStatus = statusChanged ? data.workingStatus! : lead.workingStatus;
    const isFollowUpStatus = resultingStatus === "CALL_BACK" || resultingStatus === "FOLLOW_UP";
    const followUpAt =
      isFollowUpStatus && (statusChanged || data.followUpAt)
        ? parseFollowUpAt(data.followUpAt, resultingStatus === "CALL_BACK" ? "call back" : "follow up")
        : null;

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.lead.update({ where: { id }, data: updateData, include: leadListInclude });

      if (followUpAt) {
        await scheduleFollowUp(tx, {
          leadId: id,
          leadName: [row.firstName, row.lastName].filter(Boolean).join(" "),
          assignedToId: row.ownerId ?? user.id,
          actor: { id: user.id, role: user.role },
          type: resultingStatus === "CALL_BACK" ? TaskType.CALLBACK : TaskType.FOLLOW_UP,
          scheduledAt: followUpAt,
        });
      } else if (statusChanged) {
        // Moved on to another status - any reminder still pending on the lead has been dealt with.
        await completePendingFollowUps(tx, id);
      }

      await tx.activity.create({
        data: {
          leadId: id,
          actorId: user.id,
          type: statusChanged ? ActivityType.STATUS_CHANGE : ActivityType.LEAD_UPDATED,
          title: statusChanged ? `Status changed to ${data.workingStatus}` : "Lead updated",
        },
      });

      return row;
    });

    return this.presentForRole(updated, user.role);
  }

  // Hard-deletes a Lead AND every CRM-owned record that points at it, in one transaction. Previously
  // this refused to delete any lead with recorded history at all (activities/orders/calls/tasks/
  // interestedPeriods/abandonments/recoveryActions/assignments/communicationPreferences/
  // whatsAppCampaignRecipients all have an onDelete: Restrict FK to leads, so a bare `lead.delete`
  // would fail at the DB level for any of them) - by explicit instruction this is now a real cascade
  // delete instead of a block, run inside one `$transaction` so a failure partway through leaves
  // nothing partially deleted.
  //
  // Deletion order matters: children before parents, so no FK is ever violated mid-transaction.
  //   1. Order's own children (OrderItem/Payment/Shipment - each onDelete: Restrict on orderId)
  //   2. WhatsAppMessage/WhatsAppAutomationRun matched by leadId OR orderId (both nullable FKs that
  //      default to onDelete: SetNull, but a null-leadId/orphaned-orderId row would just be silently
  //      orphaned history with no owner - explicitly deleted instead, never left behind)
  //   3. WhatsAppCampaignRecipient, WhatsAppConversation (both leadId: Restrict, not required to be
  //      empty by the old blocker check - WhatsAppConversation in particular was MISSING from it
  //      entirely, a real gap: a lead with a conversation row but no messages could previously reach
  //      `lead.delete` and fail with a raw, un-actionable Postgres FK error)
  //   4. RecoveryAction (references Abandonment too) then Abandonment
  //   5. Activity (onDelete: Restrict - the one FK that would otherwise always block the final delete),
  //      Call, InterestedLeadPeriod, LeadAssignment, CommunicationPreference, Task
  //   6. Order itself
  //   7. Lead itself
  //
  // What this never touches: Shopify and Shiprocket. Order/Payment/Shipment rows deleted here are the
  // CRM's own local mirror/link of an external record (identified by externalId) - deleting them only
  // removes the CRM's own copy and its link to this lead. No Shopify or Shiprocket API call is made
  // anywhere in this function, so the real order/shipment on those platforms is completely unaffected;
  // only the CRM stops knowing about it.
  async deleteLead(user: AuthUser, id: string): Promise<{ id: string }> {
    await this.getLeadById(user, id); // same RBAC scope + 404 as every other single-lead action

    await prisma.$transaction(async (tx) => {
      const orders = await tx.order.findMany({ where: { leadId: id }, select: { id: true } });
      const orderIds = orders.map((o) => o.id);
      const abandonments = await tx.abandonment.findMany({ where: { leadId: id }, select: { id: true } });
      const abandonmentIds = abandonments.map((a) => a.id);

      if (orderIds.length > 0) {
        await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.payment.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
      }

      await tx.whatsAppMessage.deleteMany({ where: { OR: [{ leadId: id }, ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : [])] } });
      await tx.whatsAppAutomationRun.deleteMany({ where: { OR: [{ leadId: id }, ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : [])] } });
      await tx.whatsAppCampaignRecipient.deleteMany({ where: { leadId: id } });
      await tx.whatsAppConversation.deleteMany({ where: { leadId: id } });

      await tx.recoveryAction.deleteMany({ where: { OR: [{ leadId: id }, ...(abandonmentIds.length > 0 ? [{ abandonmentId: { in: abandonmentIds } }] : [])] } });
      await tx.abandonment.deleteMany({ where: { leadId: id } });

      await tx.activity.deleteMany({ where: { leadId: id } });
      await tx.call.deleteMany({ where: { leadId: id } });
      await tx.interestedLeadPeriod.deleteMany({ where: { leadId: id } });
      await tx.leadAssignment.deleteMany({ where: { leadId: id } });
      await tx.communicationPreference.deleteMany({ where: { leadId: id } });
      await tx.task.deleteMany({ where: { leadId: id } });

      if (orderIds.length > 0) {
        await tx.order.deleteMany({ where: { id: { in: orderIds } } });
      }

      await tx.lead.delete({ where: { id } });
    });

    return { id };
  }

  async getAssignmentHistory(user: AuthUser, id: string) {
    await this.getLeadById(user, id);
    return prisma.leadAssignment.findMany({
      where: { leadId: id },
      orderBy: { assignedAt: "desc" },
      include: {
        user: { select: { id: true, name: true, role: true } },
        assignedBy: { select: { id: true, name: true, role: true } },
        group: { select: { id: true, name: true } },
      },
    });
  }

  // ---------- Assignment engine ----------

  // Bulk-assigns a batch of leads to managers in as few round trips as possible.
  // `assignments` may pair different leads with different managers (round robin) or
  // all leads with the same manager (manual) — either way this stays O(distinct
  // managers) queries instead of O(leads), which is what kept the interactive
  // transaction under Prisma's 5s timeout for anything more than a couple of leads.
  private async bulkAssignLeadsToManager(
    tx: TxClient,
    assignments: { lead: Lead; manager: User }[],
    assignedById: string | null,
    method: typeof AssignmentType.MANUAL | typeof AssignmentType.ROUND_ROBIN,
  ): Promise<void> {
    const now = new Date();
    const leadIds = assignments.map((a) => a.lead.id);

    await tx.leadAssignment.updateMany({
      where: { leadId: { in: leadIds }, isCurrent: true },
      data: { isCurrent: false, unassignedAt: now },
    });

    const freshByManager = new Map<string, string[]>();
    const reassignByManager = new Map<string, string[]>();
    const assignmentRows: Prisma.LeadAssignmentCreateManyInput[] = [];
    const activityRows: Prisma.ActivityCreateManyInput[] = [];

    for (const { lead, manager } of assignments) {
      const isReassignment = lead.assignedManagerId !== null && lead.assignedManagerId !== manager.id;
      const bucket = isReassignment ? reassignByManager : freshByManager;
      const ids = bucket.get(manager.id) ?? [];
      ids.push(lead.id);
      bucket.set(manager.id, ids);

      const assignmentId = randomUUID();
      assignmentRows.push({
        id: assignmentId,
        leadId: lead.id,
        userId: manager.id,
        assignmentType: isReassignment ? AssignmentType.REASSIGNMENT : method,
        assignedById,
        assignedAt: now,
        isCurrent: true,
      });
      activityRows.push({
        leadId: lead.id,
        actorId: assignedById,
        type: isReassignment ? ActivityType.REASSIGNMENT : ActivityType.ASSIGNMENT,
        referenceType: "LeadAssignment",
        referenceId: assignmentId,
        title: `${isReassignment ? "Reassigned" : "Assigned"} to manager ${manager.name}`,
        description: `Method: ${method}`,
      });
    }

    for (const [managerId, ids] of freshByManager) {
      await tx.lead.updateMany({ where: { id: { in: ids } }, data: { assignedManagerId: managerId } });
    }
    for (const [managerId, ids] of reassignByManager) {
      await tx.lead.updateMany({
        where: { id: { in: ids } },
        data: { assignedManagerId: managerId, ownerId: null, groupId: null },
      });
    }

    await tx.leadAssignment.createMany({ data: assignmentRows });
    await tx.activity.createMany({ data: activityRows });
  }

  // Same batching strategy as bulkAssignLeadsToManager, for Manager -> Salesperson assignment.
  private async bulkAssignLeadsToSalesperson(
    tx: TxClient,
    assignments: { lead: Lead; salesperson: User; groupId: string | null }[],
    assignedById: string | null,
    method: typeof AssignmentType.MANUAL | typeof AssignmentType.ROUND_ROBIN,
  ): Promise<void> {
    const now = new Date();
    const leadIds = assignments.map((a) => a.lead.id);

    await tx.leadAssignment.updateMany({
      where: { leadId: { in: leadIds }, isCurrent: true },
      data: { isCurrent: false, unassignedAt: now },
    });

    const bySalesperson = new Map<string, { ids: string[]; groupId: string | null }>();
    const newLeadIds: string[] = [];
    const assignmentRows: Prisma.LeadAssignmentCreateManyInput[] = [];
    const activityRows: Prisma.ActivityCreateManyInput[] = [];

    for (const { lead, salesperson, groupId } of assignments) {
      const isReassignment = lead.ownerId !== null && lead.ownerId !== salesperson.id;
      const bucket = bySalesperson.get(salesperson.id) ?? { ids: [], groupId };
      bucket.ids.push(lead.id);
      bySalesperson.set(salesperson.id, bucket);
      if (lead.workingStatus === "NEW") newLeadIds.push(lead.id);

      const assignmentId = randomUUID();
      assignmentRows.push({
        id: assignmentId,
        leadId: lead.id,
        userId: salesperson.id,
        groupId,
        assignmentType: isReassignment ? AssignmentType.REASSIGNMENT : method,
        assignedById,
        assignedAt: now,
        isCurrent: true,
      });
      activityRows.push({
        leadId: lead.id,
        actorId: assignedById,
        type: isReassignment ? ActivityType.REASSIGNMENT : ActivityType.ASSIGNMENT,
        referenceType: "LeadAssignment",
        referenceId: assignmentId,
        title: `${isReassignment ? "Reassigned" : "Assigned"} to salesperson ${salesperson.name}`,
        description: `Method: ${method}`,
      });
    }

    for (const [salespersonId, { ids, groupId }] of bySalesperson) {
      await tx.lead.updateMany({ where: { id: { in: ids } }, data: { ownerId: salespersonId, groupId } });
    }
    if (newLeadIds.length) {
      await tx.lead.updateMany({ where: { id: { in: newLeadIds } }, data: { workingStatus: "ASSIGNED" } });
    }

    await tx.leadAssignment.createMany({ data: assignmentRows });
    await tx.activity.createMany({ data: activityRows });
  }

  private async fetchLeadsOrThrow(tx: TxClient, leadIds: string[]) {
    const leads = await tx.lead.findMany({ where: { id: { in: leadIds } } });
    if (leads.length !== leadIds.length) {
      throw new ApiError("One or more leads not found", STATUS_CODES.NOT_FOUND);
    }
    return leads;
  }

  async bulkAssignManagers(adminId: string, body: BulkAssignManagerBody) {
    if (body.method === "MANUAL") {
      const manager = await prisma.user.findUnique({ where: { id: body.managerId! } });
      if (!manager || manager.role !== Role.MANAGER || manager.status !== UserStatus.ACTIVE) {
        throw new ApiError("Invalid or inactive manager", STATUS_CODES.BAD_REQUEST);
      }
      return prisma.$transaction(
        async (tx) => {
          const leads = await this.fetchLeadsOrThrow(tx, body.leadIds);
          await this.bulkAssignLeadsToManager(
            tx,
            leads.map((lead) => ({ lead, manager })),
            adminId,
            AssignmentType.MANUAL,
          );
          return { assignedCount: leads.length };
        },
        { timeout: 20000, maxWait: 10000 },
      );
    }

    const managers = await prisma.user.findMany({
      where: { id: { in: body.managerIds! }, role: Role.MANAGER, status: UserStatus.ACTIVE },
    });
    if (managers.length !== body.managerIds!.length) {
      throw new ApiError("One or more managers are invalid or inactive", STATUS_CODES.BAD_REQUEST);
    }
    const orderedManagers = body.managerIds!.map((id) => managers.find((m) => m.id === id)!);

    return prisma.$transaction(
      async (tx) => {
        const cursorRows = await tx.$queryRaw<{ id: string; lastAssignedManagerId: string | null }[]>`
        SELECT id, last_assigned_manager_id AS "lastAssignedManagerId"
        FROM manager_assignment_round_robin
        LIMIT 1
        FOR UPDATE
      `;

        let cursor = cursorRows[0];
        if (!cursor) {
          const created = await tx.managerAssignmentRoundRobin.create({ data: {} });
          cursor = { id: created.id, lastAssignedManagerId: created.lastAssignedManagerId };
        }

        const managerIds = orderedManagers.map((m) => m.id);
        let position = 0;
        if (cursor.lastAssignedManagerId) {
          const idx = managerIds.indexOf(cursor.lastAssignedManagerId);
          position = idx === -1 ? 0 : (idx + 1) % managerIds.length;
        }

        const leads = await this.fetchLeadsOrThrow(tx, body.leadIds);
        const assignments = leads.map((lead) => ({ lead, manager: orderedManagers[position++ % managerIds.length]! }));
        const lastUsedManagerId = assignments.length ? assignments[assignments.length - 1]!.manager.id : cursor.lastAssignedManagerId;

        await this.bulkAssignLeadsToManager(tx, assignments, adminId, AssignmentType.ROUND_ROBIN);

        await tx.managerAssignmentRoundRobin.update({
          where: { id: cursor.id },
          data: { lastAssignedManagerId: lastUsedManagerId },
        });

        return { assignedCount: leads.length };
      },
      { timeout: 20000, maxWait: 10000 },
    );
  }

  // Resolves a salesperson id to whoever this manager is allowed to assign leads
  // to: anyone reporting to them (self-added, or admin-assigned), whether or not
  // they've been placed in a group yet. If they're an active member of one of
  // this manager's groups, the lead inherits that group; otherwise it's assigned
  // with no group (groupId is nullable on Lead precisely for this case).
  private async resolveTeamMember(managerId: string, salespersonId: string) {
    const membership = await prisma.groupMember.findFirst({
      where: { userId: salespersonId, isActive: true, group: { managerId, status: "ACTIVE" } },
      include: { user: true },
    });
    if (membership) {
      if (membership.user.role !== Role.SALESPERSON || membership.user.status !== UserStatus.ACTIVE) {
        throw new ApiError("Salesperson is not part of your team", STATUS_CODES.BAD_REQUEST);
      }
      return { user: membership.user, groupId: membership.groupId as string | null };
    }

    const salesperson = await prisma.user.findUnique({ where: { id: salespersonId } });
    if (
      !salesperson ||
      salesperson.role !== Role.SALESPERSON ||
      salesperson.status !== UserStatus.ACTIVE ||
      salesperson.reportingManagerId !== managerId
    ) {
      throw new ApiError("Salesperson is not part of your team", STATUS_CODES.BAD_REQUEST);
    }
    return { user: salesperson, groupId: null as string | null };
  }

  async bulkAssignSalespersons(managerId: string, body: BulkAssignSalespersonBody) {
    if (body.method === "MANUAL") {
      const { user: salesperson, groupId } = await this.resolveTeamMember(managerId, body.salespersonId!);

      return prisma.$transaction(
        async (tx) => {
          const leads = await this.fetchLeadsOrThrow(tx, body.leadIds);
          if (leads.some((lead) => lead.assignedManagerId !== managerId)) {
            throw new ApiError("One or more leads are not assigned to you", STATUS_CODES.FORBIDDEN);
          }
          await this.bulkAssignLeadsToSalesperson(
            tx,
            leads.map((lead) => ({ lead, salesperson, groupId })),
            managerId,
            AssignmentType.MANUAL,
          );
          return { assignedCount: leads.length };
        },
        { timeout: 20000, maxWait: 10000 },
      );
    }

    const resolvedMembers = await Promise.all(
      body.salespersonIds!.map((id) => this.resolveTeamMember(managerId, id)),
    );
    const groupBySalesperson = new Map(resolvedMembers.map((m) => [m.user.id, m.groupId]));
    const orderedSalespeople = resolvedMembers.map((m) => m.user);

    return prisma.$transaction(
      async (tx) => {
        const cursorRows = await tx.$queryRaw<{ id: string; lastAssignedSalespersonId: string | null }[]>`
        SELECT id, last_assigned_salesperson_id AS "lastAssignedSalespersonId"
        FROM salesperson_assignment_round_robin
        WHERE manager_id = ${managerId}::uuid
        FOR UPDATE
      `;

        let cursor = cursorRows[0];
        if (!cursor) {
          const created = await tx.salespersonAssignmentRoundRobin.create({ data: { managerId } });
          cursor = { id: created.id, lastAssignedSalespersonId: created.lastAssignedSalespersonId };
        }

        const salespersonIds = orderedSalespeople.map((s) => s.id);
        let position = 0;
        if (cursor.lastAssignedSalespersonId) {
          const idx = salespersonIds.indexOf(cursor.lastAssignedSalespersonId);
          position = idx === -1 ? 0 : (idx + 1) % salespersonIds.length;
        }

        const leads = await this.fetchLeadsOrThrow(tx, body.leadIds);
        if (leads.some((lead) => lead.assignedManagerId !== managerId)) {
          throw new ApiError("One or more leads are not assigned to you", STATUS_CODES.FORBIDDEN);
        }

        const assignments = leads.map((lead) => {
          const salesperson = orderedSalespeople[position++ % salespersonIds.length]!;
          return { lead, salesperson, groupId: groupBySalesperson.get(salesperson.id)! };
        });
        const lastUsedSalespersonId = assignments.length
          ? assignments[assignments.length - 1]!.salesperson.id
          : cursor.lastAssignedSalespersonId;

        await this.bulkAssignLeadsToSalesperson(tx, assignments, managerId, AssignmentType.ROUND_ROBIN);

        await tx.salespersonAssignmentRoundRobin.update({
          where: { id: cursor.id },
          data: { lastAssignedSalespersonId: lastUsedSalespersonId },
        });

        return { assignedCount: leads.length };
      },
      { timeout: 20000, maxWait: 10000 },
    );
  }

  // Admin-only bulk status change (e.g. cleaning up test leads without touching the database
  // directly). Unlike updateLead, this sets the real workingStatus unconditionally for every
  // selected lead - there's no "shown status" role view to reconcile against since only ADMIN can
  // call it. One followUpAt, if given, applies to every lead moved to CALL_BACK/FOLLOW_UP; each
  // lead's own owner (falling back to the admin) gets the reminder, same as the single-lead path.
  async bulkUpdateStatus(user: AuthUser, body: BulkUpdateStatusBody) {
    const isFollowUpStatus = body.workingStatus === "CALL_BACK" || body.workingStatus === "FOLLOW_UP";
    const followUpAt = isFollowUpStatus ? parseFollowUpAt(body.followUpAt, body.workingStatus === "CALL_BACK" ? "call back" : "follow up") : null;

    return prisma.$transaction(
      async (tx) => {
        const leads = await this.fetchLeadsOrThrow(tx, body.leadIds);

        await tx.lead.updateMany({ where: { id: { in: body.leadIds } }, data: { workingStatus: body.workingStatus } });

        for (const lead of leads) {
          if (followUpAt) {
            await scheduleFollowUp(tx, {
              leadId: lead.id,
              leadName: [lead.firstName, lead.lastName].filter(Boolean).join(" "),
              assignedToId: lead.ownerId ?? user.id,
              actor: { id: user.id, role: user.role },
              type: body.workingStatus === "CALL_BACK" ? TaskType.CALLBACK : TaskType.FOLLOW_UP,
              scheduledAt: followUpAt,
            });
          } else {
            await completePendingFollowUps(tx, lead.id);
          }
        }

        await tx.activity.createMany({
          data: leads.map((lead) => ({
            leadId: lead.id,
            actorId: user.id,
            type: ActivityType.STATUS_CHANGE,
            title: `Status changed to ${body.workingStatus}`,
          })),
        });

        return { updatedCount: leads.length };
      },
      { timeout: 20000, maxWait: 10000 },
    );
  }

  // ---------- Auto-assignment (abandoned leads) ----------
  // Same round-robin engine as bulkAssignManagers/bulkAssignSalespersons above, triggered by the
  // ingesting processor (e.g. shiprocket.abandonment.processor.ts) instead of an admin/manager
  // request. The only differences: the manager-stage pool is "every ACTIVE manager the admin has
  // opted in via ManagerAutoAssignTarget" (the salesperson-stage pool is still "every ACTIVE
  // salesperson under that manager" - no per-salesperson opt-in yet), it acts on one lead at a time,
  // and assignedById is null (system-triggered) rather than a real user id -
  // LeadAssignment.assignedById/Activity.actorId are both nullable precisely for this. Each toggle
  // (ManagerAutoAssignConfig, SalespersonAutoAssignConfig) is read fresh on every call - a single
  // indexed row read costs nothing extra inside a transaction that's already doing real writes, so
  // there's no need to cache or invalidate it.

  /** No-ops (leaving the lead unassigned, same as if auto-assign were off) when the config row is
   *  missing/disabled, the lead already has a manager, or there are no active managers to pick from. */
  async autoAssignManagerForLead(tx: TxClient, lead: Lead): Promise<Lead> {
    if (lead.assignedManagerId) return lead;

    const config = await tx.managerAutoAssignConfig.findFirst({ select: { enabled: true } });
    if (!config?.enabled) return lead;

    const managers = await tx.user.findMany({
      where: { role: Role.MANAGER, status: UserStatus.ACTIVE, managerAutoAssignTarget: { isNot: null } },
      orderBy: { id: "asc" },
    });
    if (managers.length === 0) return lead;

    const cursorRows = await tx.$queryRaw<{ id: string; lastAssignedManagerId: string | null }[]>`
      SELECT id, last_assigned_manager_id AS "lastAssignedManagerId"
      FROM manager_assignment_round_robin
      LIMIT 1
      FOR UPDATE
    `;
    let cursor = cursorRows[0];
    if (!cursor) {
      const created = await tx.managerAssignmentRoundRobin.create({ data: {} });
      cursor = { id: created.id, lastAssignedManagerId: created.lastAssignedManagerId };
    }

    const managerIds = managers.map((m) => m.id);
    let position = 0;
    if (cursor.lastAssignedManagerId) {
      const idx = managerIds.indexOf(cursor.lastAssignedManagerId);
      position = idx === -1 ? 0 : (idx + 1) % managerIds.length;
    }
    const manager = managers[position]!;

    await this.bulkAssignLeadsToManager(tx, [{ lead, manager }], null, AssignmentType.ROUND_ROBIN);
    await tx.managerAssignmentRoundRobin.update({ where: { id: cursor.id }, data: { lastAssignedManagerId: manager.id } });

    return { ...lead, assignedManagerId: manager.id };
  }

  /** Same guard shape as autoAssignManagerForLead: no-ops when the lead has no manager yet, already
   *  has an owner, that manager's own toggle is off, or that manager has no active salespeople. */
  async autoAssignSalespersonForLead(tx: TxClient, lead: Lead): Promise<void> {
    if (!lead.assignedManagerId || lead.ownerId) return;

    const config = await tx.salespersonAutoAssignConfig.findUnique({
      where: { managerId: lead.assignedManagerId },
      select: { enabled: true },
    });
    if (!config?.enabled) return;

    const salespeople = await tx.user.findMany({
      where: { role: Role.SALESPERSON, status: UserStatus.ACTIVE, reportingManagerId: lead.assignedManagerId },
      orderBy: { id: "asc" },
    });
    if (salespeople.length === 0) return;

    const cursorRows = await tx.$queryRaw<{ id: string; lastAssignedSalespersonId: string | null }[]>`
      SELECT id, last_assigned_salesperson_id AS "lastAssignedSalespersonId"
      FROM salesperson_assignment_round_robin
      WHERE manager_id = ${lead.assignedManagerId}::uuid
      FOR UPDATE
    `;
    let cursor = cursorRows[0];
    if (!cursor) {
      const created = await tx.salespersonAssignmentRoundRobin.create({ data: { managerId: lead.assignedManagerId } });
      cursor = { id: created.id, lastAssignedSalespersonId: created.lastAssignedSalespersonId };
    }

    const salespersonIds = salespeople.map((s) => s.id);
    let position = 0;
    if (cursor.lastAssignedSalespersonId) {
      const idx = salespersonIds.indexOf(cursor.lastAssignedSalespersonId);
      position = idx === -1 ? 0 : (idx + 1) % salespersonIds.length;
    }
    const salesperson = salespeople[position]!;

    // Same "inherit an active group under this manager, else no group" resolution resolveTeamMember
    // uses for manual assignment - a salesperson not yet placed in a group can still be auto-assigned.
    const membership = await tx.groupMember.findFirst({
      where: { userId: salesperson.id, isActive: true, group: { managerId: lead.assignedManagerId, status: "ACTIVE" } },
      select: { groupId: true },
    });
    const groupId = membership?.groupId ?? null;

    await this.bulkAssignLeadsToSalesperson(tx, [{ lead, salesperson, groupId }], null, AssignmentType.ROUND_ROBIN);
    await tx.salespersonAssignmentRoundRobin.update({ where: { id: cursor.id }, data: { lastAssignedSalespersonId: salesperson.id } });
  }

  /** Assigns a lead to a specific salesperson chosen by a routing rule (not round-robin, not a manual click) - same bookkeeping
   *  as every other assignment (LeadAssignment row, current-owner flip, Activity), group inherited from that salesperson's manager.
   *  A no-op when the lead already has an owner: a rule never takes a lead away from someone. */
  async assignToSalespersonByRule(tx: TxClient, lead: Lead, salesperson: User, ruleDescription: string): Promise<boolean> {
    if (lead.ownerId) return false;
    const managerId = salesperson.reportingManagerId;
    const membership = managerId
      ? await tx.groupMember.findFirst({ where: { userId: salesperson.id, isActive: true, group: { managerId, status: "ACTIVE" } }, select: { groupId: true } })
      : null;
    await this.bulkAssignLeadsToSalesperson(tx, [{ lead, salesperson, groupId: membership?.groupId ?? null }], null, AssignmentType.MANUAL);
    await tx.activity.create({ data: { leadId: lead.id, type: ActivityType.ASSIGNMENT, referenceType: "Lead", referenceId: lead.id, title: `Routed to ${salesperson.name} by product routing`, description: ruleDescription } });
    return true;
  }

  /** Entry point for a newly-created abandoned lead: tries the manager stage, then (whether a
   *  manager was just assigned or already present) the salesperson stage. Each stage's own toggle
   *  decides whether anything actually happens - safe to call unconditionally. */
  async autoAssignAbandonedLead(tx: TxClient, lead: Lead): Promise<void> {
    const withManager = await this.autoAssignManagerForLead(tx, lead);
    await this.autoAssignSalespersonForLead(tx, withManager);
  }

  // ---------- CSV import ----------

  async previewImport(user: AuthUser, file: Express.Multer.File, columnMapping: Record<string, string>) {
    const rawRows: Record<string, string>[] = parse(file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const parsedRows: ParsedImportRow[] = [];
    const errorRows: ImportRowError[] = [];
    const seenMobiles = new Set<string>();
    const seenEmails = new Set<string>();

    const mapped = rawRows.map((row) => {
      const out: Record<string, string> = {};
      for (const [csvColumn, crmField] of Object.entries(columnMapping)) {
        if (row[csvColumn] !== undefined) out[crmField] = row[csvColumn];
      }
      return out;
    });

    const candidateMobiles = mapped.map((r) => normalizeMobile(r.mobile)).filter((v): v is string => Boolean(v));
    const candidateEmails = mapped.map((r) => normalizeEmail(r.email)).filter((v): v is string => Boolean(v));

    const orConditions: Prisma.LeadWhereInput[] = [];
    if (candidateMobiles.length) orConditions.push({ normalizedMobile: { in: candidateMobiles } });
    if (candidateEmails.length) orConditions.push({ normalizedEmail: { in: candidateEmails } });

    const existing = orConditions.length
      ? await prisma.lead.findMany({
          where: { OR: orConditions },
          select: { normalizedMobile: true, normalizedEmail: true },
        })
      : [];
    const existingMobiles = new Set(existing.map((e) => e.normalizedMobile).filter(Boolean) as string[]);
    const existingEmails = new Set(existing.map((e) => e.normalizedEmail).filter(Boolean) as string[]);

    mapped.forEach((row, index) => {
      const rowNumber = index + 2; // account for header row
      const firstName = row.firstName?.trim();
      const normalizedMobile = normalizeMobile(row.mobile);
      const normalizedEmail = normalizeEmail(row.email);

      if (!firstName) {
        errorRows.push({ row: rowNumber, reason: "Missing firstName" });
        return;
      }
      if (!normalizedMobile && !normalizedEmail) {
        errorRows.push({ row: rowNumber, reason: "Missing both mobile and email" });
        return;
      }

      const isDuplicate =
        (normalizedMobile && (existingMobiles.has(normalizedMobile) || seenMobiles.has(normalizedMobile))) ||
        (normalizedEmail && (existingEmails.has(normalizedEmail) || seenEmails.has(normalizedEmail)));

      if (isDuplicate) {
        errorRows.push({ row: rowNumber, reason: "Duplicate mobile/email" });
        return;
      }

      if (normalizedMobile) seenMobiles.add(normalizedMobile);
      if (normalizedEmail) seenEmails.add(normalizedEmail);

      parsedRows.push({
        firstName,
        lastName: row.lastName?.trim() || undefined,
        mobile: row.mobile?.trim() || undefined,
        normalizedMobile: normalizedMobile ?? undefined,
        email: row.email?.trim() || undefined,
        normalizedEmail: normalizedEmail ?? undefined,
        requirement: row.requirement?.trim() || undefined,
        location: row.location?.trim() || undefined,
        sourceName: row.sourceName?.trim() || undefined,
      });
    });

    const duplicateRows = errorRows.filter((e) => e.reason === "Duplicate mobile/email").length;
    const invalidRows = errorRows.length - duplicateRows;

    const batch = await prisma.leadImportBatch.create({
      data: {
        fileName: file.originalname,
        uploadedById: user.id,
        status: ImportBatchStatus.DRAFT,
        totalRows: rawRows.length,
        validRows: parsedRows.length,
        duplicateRows,
        invalidRows,
        columnMapping,
        parsedRows: parsedRows as unknown as Prisma.InputJsonValue,
        errorRows: errorRows as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      batchId: batch.id,
      totalRows: batch.totalRows,
      validRows: batch.validRows,
      duplicateRows: batch.duplicateRows,
      invalidRows: batch.invalidRows,
      sampleErrors: errorRows.slice(0, 20),
    };
  }

  // A manager may only act on their own import batches — not an admin's or another
  // manager's. Reported as 404 (not 403) so batch existence isn't leaked cross-account.
  private assertBatchOwnership(user: AuthUser, batch: { uploadedById: string }): void {
    if (user.role === Role.MANAGER && batch.uploadedById !== user.id) {
      throw new ApiError("Import batch not found", STATUS_CODES.NOT_FOUND);
    }
  }

  async confirmImport(user: AuthUser, batchId: string) {
    const batch = await prisma.leadImportBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new ApiError("Import batch not found", STATUS_CODES.NOT_FOUND);
    this.assertBatchOwnership(user, batch);
    if (batch.status !== ImportBatchStatus.DRAFT) {
      throw new ApiError("Import batch already processed", STATUS_CODES.CONFLICT);
    }

    const rows = (batch.parsedRows as unknown as ParsedImportRow[]) ?? [];
    if (rows.length === 0) {
      throw new ApiError("No valid rows to import", STATUS_CODES.BAD_REQUEST);
    }

    // Resolve every distinct source name up front (outside any transaction) so the
    // per-row work inside the transaction is pure inserts with no network round trips
    // to look up/upsert sources — that per-row upsert was what pushed large imports
    // past Prisma's 5s interactive-transaction timeout.
    const sourceCache = new Map<string, string>();
    const distinctSourceNames = new Set(rows.map((r) => r.sourceName?.trim() || "CSV Import"));
    for (const sourceName of distinctSourceNames) {
      const source = await prisma.source.upsert({
        where: { code: sourceName.toUpperCase().replace(/\s+/g, "_") },
        update: {},
        create: { name: sourceName, code: sourceName.toUpperCase().replace(/\s+/g, "_") },
      });
      sourceCache.set(sourceName, source.id);
    }

    const chunkSize = 200;
    let createdCount = 0;
    const usedLeadNumbers = new Set<string>();

    // A manager who imports leads keeps them — the lead lands assigned to
    // that manager immediately instead of sitting in Admin's unassigned pool.
    // Admin still sees every lead regardless (ADMIN has unrestricted scope),
    // and the "via {uploadedBy}" source-column note still reflects who brought it in.
    const isManagerImport = user.role === Role.MANAGER;

    const uniqueLeadNumber = (): string => {
      let leadNumber = generateLeadNumber();
      while (usedLeadNumbers.has(leadNumber)) leadNumber = generateLeadNumber();
      usedLeadNumbers.add(leadNumber);
      return leadNumber;
    };

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const leadRows = chunk.map((row) => ({
        id: randomUUID(),
        leadNumber: uniqueLeadNumber(),
        firstName: row.firstName,
        lastName: row.lastName,
        mobile: row.mobile,
        normalizedMobile: row.normalizedMobile,
        email: row.email,
        normalizedEmail: row.normalizedEmail,
        requirement: row.requirement,
        location: row.location,
        sourceId: sourceCache.get(row.sourceName?.trim() || "CSV Import"),
        importBatchId: batch.id,
        assignedManagerId: isManagerImport ? user.id : undefined,
      }));

      await prisma.$transaction(
        async (tx) => {
          await tx.lead.createMany({ data: leadRows });
          await tx.activity.createMany({
            data: leadRows.map((lead) => ({
              leadId: lead.id,
              type: ActivityType.LEAD_CREATED,
              referenceType: "LeadImportBatch",
              referenceId: batch.id,
              title: "Lead created via CSV import",
            })),
          });

          if (isManagerImport) {
            const now = new Date();
            await tx.leadAssignment.createMany({
              data: leadRows.map((lead) => ({
                id: randomUUID(),
                leadId: lead.id,
                userId: user.id,
                assignmentType: AssignmentType.MANUAL,
                assignedById: user.id,
                assignedAt: now,
                isCurrent: true,
              })),
            });
            await tx.activity.createMany({
              data: leadRows.map((lead) => ({
                leadId: lead.id,
                actorId: user.id,
                type: ActivityType.ASSIGNMENT,
                referenceType: "LeadImportBatch",
                referenceId: batch.id,
                title: "Auto-assigned to importing manager",
                description: "Method: CSV_IMPORT",
              })),
            });
          }
        },
        { timeout: 30000, maxWait: 10000 },
      );
      createdCount += leadRows.length;
    }

    await prisma.leadImportBatch.update({
      where: { id: batch.id },
      data: { status: ImportBatchStatus.COMMITTED, committedAt: new Date(), parsedRows: Prisma.DbNull },
    });

    return { batchId: batch.id, createdCount };
  }

  async getImportBatch(user: AuthUser, batchId: string) {
    const batch = await prisma.leadImportBatch.findUnique({
      where: { id: batchId },
      select: {
        id: true,
        fileName: true,
        status: true,
        totalRows: true,
        validRows: true,
        duplicateRows: true,
        invalidRows: true,
        errorRows: true,
        createdAt: true,
        committedAt: true,
        uploadedById: true,
      },
    });
    if (!batch) throw new ApiError("Import batch not found", STATUS_CODES.NOT_FOUND);
    this.assertBatchOwnership(user, batch);
    const { uploadedById: _uploadedById, ...publicBatch } = batch;
    return publicBatch;
  }

  // Used by the integrations module for webhook-originated leads (Meta/Shopify), which
  // have no `user` actor and so skip the interactive createLead() owner/manager
  // assignment logic — leads land unassigned and surface via the existing
  // assignment=UNASSIGNED lead filter for admins/managers to pick up.
  async createLeadFromSource(
    sourceId: string,
    data: {
      firstName: string;
      lastName?: string;
      mobile?: string;
      email?: string;
      requirement?: string;
      location?: string;
    },
    activityTitle: string,
    // Defaults to the global client; a caller already inside its own transaction passes it so these
    // writes see that caller's uncommitted rows (e.g. a Source it just created).
    client: TxClient | typeof prisma = prisma,
  ) {
    const normalizedMobile = normalizeMobile(data.mobile);
    const normalizedEmail = normalizeEmail(data.email);

    // A single external customer can hit this path repeatedly over their lifecycle
    // (e.g. Shopify's separate create/update webhooks). Dedup on normalized
    // mobile/email so a later, more-complete event enriches the existing lead
    // instead of spawning a duplicate.
    const existing =
      normalizedMobile || normalizedEmail
        ? await client.lead.findFirst({
            where: {
              sourceId,
              OR: [
                ...(normalizedMobile ? [{ normalizedMobile }] : []),
                ...(normalizedEmail ? [{ normalizedEmail }] : []),
              ],
            },
          })
        : null;

    if (existing) {
      const lead = await client.lead.update({
        where: { id: existing.id },
        data: {
          firstName: data.firstName || existing.firstName,
          lastName: data.lastName ?? existing.lastName,
          mobile: data.mobile ?? existing.mobile,
          normalizedMobile: normalizedMobile ?? existing.normalizedMobile,
          email: data.email ?? existing.email,
          normalizedEmail: normalizedEmail ?? existing.normalizedEmail,
          location: data.location ?? existing.location,
        },
      });

      await client.activity.create({
        data: {
          leadId: lead.id,
          type: ActivityType.LEAD_UPDATED,
          referenceType: "Source",
          referenceId: sourceId,
          title: `Lead updated via ${activityTitle.replace("Lead created via ", "")}`,
        },
      });

      return lead;
    }

    const lead = await this.createLeadWithUniqueNumber({
      firstName: data.firstName,
      lastName: data.lastName,
      mobile: data.mobile,
      normalizedMobile,
      email: data.email,
      normalizedEmail,
      requirement: data.requirement,
      location: data.location,
      sourceId,
    }, client);

    await client.activity.create({
      data: {
        leadId: lead.id,
        type: ActivityType.LEAD_CREATED,
        referenceType: "Source",
        referenceId: sourceId,
        title: activityTitle,
      },
    });

    return lead;
  }
}

export default LeadService;
