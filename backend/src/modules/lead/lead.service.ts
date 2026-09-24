import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { generateLeadNumber } from "@/utils/leadNumber.js";
import { normalizeMobile, normalizeEmail } from "@/utils/normalize.js";
import {
  Role,
  UserStatus,
  ImportBatchStatus,
  AssignmentType,
  ActivityType,
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
  owner: { select: { id: true, name: true, email: true } },
  assignedManager: { select: { id: true, name: true, email: true } },
  group: { select: { id: true, name: true } },
  importBatch: { select: { fileName: true, uploadedBy: { select: { id: true, name: true, role: true } } } },
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
    },
    orderBy: { createdAt: "desc" },
  },
} satisfies Prisma.LeadInclude;

class LeadService {
  // Salespersons see their calls (status, duration) but can't hear the recording —
  // only managers/admins can listen. Strip the URL out rather than the whole call.
  private redactRecordingsForRole<T extends { calls: { recording: { recordingUrl: string | null } | null }[] }>(
    entity: T,
    role: Role,
  ): T {
    if (role !== Role.SALESPERSON) return entity;
    return {
      ...entity,
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
    if (query.workingStatus) where.workingStatus = query.workingStatus as Lead["workingStatus"];
    where.lifecycleStage = query.lifecycleStage ?? "LEAD";

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
      data: data.map((lead) => this.redactRecordingsForRole(lead, user.role)),
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
    return this.redactRecordingsForRole(lead, user.role);
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
    const lead = await this.getLeadById(user, id);

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
    if (data.workingStatus !== undefined) updateData.workingStatus = data.workingStatus;

    const updated = await prisma.lead.update({ where: { id }, data: updateData, include: leadListInclude });

    await prisma.activity.create({
      data: {
        leadId: id,
        actorId: user.id,
        type: data.workingStatus && data.workingStatus !== lead.workingStatus ? ActivityType.STATUS_CHANGE : ActivityType.LEAD_UPDATED,
        title: data.workingStatus && data.workingStatus !== lead.workingStatus ? `Status changed to ${data.workingStatus}` : "Lead updated",
      },
    });

    return this.redactRecordingsForRole(updated, user.role);
  }

  // Hard-deletes a Lead. The schema already protects real lead history at the DB level -
  // activities/orders/calls/tasks/interestedPeriods/abandonments/recoveryActions/assignments/
  // communicationPreferences/whatsAppCampaignRecipients all have an explicit ON DELETE RESTRICT
  // FK to leads, and would raise a raw Postgres error if deletion were attempted anyway.
  // whatsAppMessages/whatsAppAutomationRuns are ON DELETE SET NULL instead, so the DB alone
  // wouldn't stop a delete there - but doing so would silently orphan a customer's WhatsApp
  // history and Lead -> WhatsApp linking, which is explicitly never allowed to happen. So every
  // one of these is checked up front and reported as one clear, actionable error, rather than
  // ever attempting to work around any of them with a cascading delete or a schema change.
  private async assertLeadIsDeletable(id: string): Promise<void> {
    const [
      activityCount,
      orderCount,
      callCount,
      taskCount,
      interestedPeriodCount,
      abandonmentCount,
      recoveryActionCount,
      assignmentCount,
      communicationPreferenceCount,
      whatsAppMessageCount,
      whatsAppAutomationRunCount,
      whatsAppCampaignRecipientCount,
    ] = await Promise.all([
      prisma.activity.count({ where: { leadId: id } }),
      prisma.order.count({ where: { leadId: id } }),
      prisma.call.count({ where: { leadId: id } }),
      prisma.task.count({ where: { leadId: id } }),
      prisma.interestedLeadPeriod.count({ where: { leadId: id } }),
      prisma.abandonment.count({ where: { leadId: id } }),
      prisma.recoveryAction.count({ where: { leadId: id } }),
      prisma.leadAssignment.count({ where: { leadId: id } }),
      prisma.communicationPreference.count({ where: { leadId: id } }),
      prisma.whatsAppMessage.count({ where: { leadId: id } }),
      prisma.whatsAppAutomationRun.count({ where: { leadId: id } }),
      prisma.whatsAppCampaignRecipient.count({ where: { leadId: id } }),
    ]);

    const blockers: string[] = [];
    if (activityCount > 0) blockers.push(`${activityCount} activity record(s)`);
    if (orderCount > 0) blockers.push(`${orderCount} order(s)`);
    if (callCount > 0) blockers.push(`${callCount} call(s)`);
    if (taskCount > 0) blockers.push(`${taskCount} task(s)`);
    if (interestedPeriodCount > 0) blockers.push(`${interestedPeriodCount} interested-period record(s)`);
    if (abandonmentCount > 0) blockers.push(`${abandonmentCount} abandonment record(s)`);
    if (recoveryActionCount > 0) blockers.push(`${recoveryActionCount} recovery action(s)`);
    if (assignmentCount > 0) blockers.push(`${assignmentCount} assignment record(s)`);
    if (communicationPreferenceCount > 0) blockers.push(`${communicationPreferenceCount} communication preference(s)`);
    if (whatsAppMessageCount > 0) blockers.push(`${whatsAppMessageCount} WhatsApp message(s)`);
    if (whatsAppAutomationRunCount > 0) blockers.push(`${whatsAppAutomationRunCount} WhatsApp automation run(s)`);
    if (whatsAppCampaignRecipientCount > 0) blockers.push(`${whatsAppCampaignRecipientCount} WhatsApp campaign recipient record(s)`);

    if (blockers.length > 0) {
      throw new ApiError(
        `Cannot delete this lead: it has existing ${blockers.join(", ")}. Deletion is only allowed for a lead with no recorded history.`,
        STATUS_CODES.CONFLICT,
      );
    }
  }

  async deleteLead(user: AuthUser, id: string): Promise<{ id: string }> {
    await this.getLeadById(user, id); // same RBAC scope + 404 as every other single-lead action
    await this.assertLeadIsDeletable(id);
    await prisma.lead.delete({ where: { id } });
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
    assignedById: string,
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
    assignments: { lead: Lead; salesperson: User; groupId: string }[],
    assignedById: string,
    method: typeof AssignmentType.MANUAL | typeof AssignmentType.ROUND_ROBIN,
  ): Promise<void> {
    const now = new Date();
    const leadIds = assignments.map((a) => a.lead.id);

    await tx.leadAssignment.updateMany({
      where: { leadId: { in: leadIds }, isCurrent: true },
      data: { isCurrent: false, unassignedAt: now },
    });

    const bySalesperson = new Map<string, { ids: string[]; groupId: string }>();
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

  // Resolves a salesperson id to their active group membership under THIS manager.
  // The manager picks a person, not a group — the group is implicit, and a
  // salesperson who isn't currently on this manager's active team is rejected.
  private async resolveTeamMember(managerId: string, salespersonId: string) {
    const membership = await prisma.groupMember.findFirst({
      where: { userId: salespersonId, isActive: true, group: { managerId, status: "ACTIVE" } },
      include: { user: true },
    });
    if (!membership || membership.user.role !== Role.SALESPERSON || membership.user.status !== UserStatus.ACTIVE) {
      throw new ApiError("Salesperson is not part of your active team", STATUS_CODES.BAD_REQUEST);
    }
    return { user: membership.user, groupId: membership.groupId };
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
