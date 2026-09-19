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
} satisfies Prisma.LeadInclude;

class LeadService {
  private buildScopeWhere(user: AuthUser): Prisma.LeadWhereInput {
    if (user.role === Role.MANAGER) return { assignedManagerId: user.id };
    if (user.role === Role.SALESPERSON) return { ownerId: user.id };
    return {};
  }

  async listLeads(user: AuthUser, query: ListLeadsQuery) {
    const where: Prisma.LeadWhereInput = { ...this.buildScopeWhere(user) };

    if (query.sourceId) where.sourceId = query.sourceId;
    if (query.workingStatus) where.workingStatus = query.workingStatus as Lead["workingStatus"];

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
      data,
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
    return lead;
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

    return updated;
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

  private async assignLeadToManager(
    tx: TxClient,
    lead: Lead,
    manager: User,
    assignedById: string,
    method: typeof AssignmentType.MANUAL | typeof AssignmentType.ROUND_ROBIN,
  ): Promise<void> {
    const isReassignment = lead.assignedManagerId !== null && lead.assignedManagerId !== manager.id;
    const now = new Date();

    await tx.leadAssignment.updateMany({
      where: { leadId: lead.id, isCurrent: true },
      data: { isCurrent: false, unassignedAt: now },
    });

    await tx.lead.update({
      where: { id: lead.id },
      data: isReassignment
        ? { assignedManagerId: manager.id, ownerId: null, groupId: null }
        : { assignedManagerId: manager.id },
    });

    const assignment = await tx.leadAssignment.create({
      data: {
        leadId: lead.id,
        userId: manager.id,
        assignmentType: isReassignment ? AssignmentType.REASSIGNMENT : method,
        assignedById,
        assignedAt: now,
        isCurrent: true,
      },
    });

    await tx.activity.create({
      data: {
        leadId: lead.id,
        actorId: assignedById,
        type: isReassignment ? ActivityType.REASSIGNMENT : ActivityType.ASSIGNMENT,
        referenceType: "LeadAssignment",
        referenceId: assignment.id,
        title: `${isReassignment ? "Reassigned" : "Assigned"} to manager ${manager.name}`,
        description: `Method: ${method}`,
      },
    });
  }

  private async assignLeadToSalesperson(
    tx: TxClient,
    lead: Lead,
    salesperson: User,
    groupId: string,
    assignedById: string,
    method: typeof AssignmentType.MANUAL | typeof AssignmentType.ROUND_ROBIN,
  ): Promise<void> {
    const isReassignment = lead.ownerId !== null && lead.ownerId !== salesperson.id;
    const now = new Date();

    await tx.leadAssignment.updateMany({
      where: { leadId: lead.id, isCurrent: true },
      data: { isCurrent: false, unassignedAt: now },
    });

    await tx.lead.update({
      where: { id: lead.id },
      data: {
        ownerId: salesperson.id,
        groupId,
        workingStatus: lead.workingStatus === "NEW" ? "ASSIGNED" : lead.workingStatus,
      },
    });

    const assignment = await tx.leadAssignment.create({
      data: {
        leadId: lead.id,
        userId: salesperson.id,
        groupId,
        assignmentType: isReassignment ? AssignmentType.REASSIGNMENT : method,
        assignedById,
        assignedAt: now,
        isCurrent: true,
      },
    });

    await tx.activity.create({
      data: {
        leadId: lead.id,
        actorId: assignedById,
        type: isReassignment ? ActivityType.REASSIGNMENT : ActivityType.ASSIGNMENT,
        referenceType: "LeadAssignment",
        referenceId: assignment.id,
        title: `${isReassignment ? "Reassigned" : "Assigned"} to salesperson ${salesperson.name}`,
        description: `Method: ${method}`,
      },
    });
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
      return prisma.$transaction(async (tx) => {
        const leads = await this.fetchLeadsOrThrow(tx, body.leadIds);
        for (const lead of leads) {
          await this.assignLeadToManager(tx, lead, manager, adminId, AssignmentType.MANUAL);
        }
        return { assignedCount: leads.length };
      });
    }

    const managers = await prisma.user.findMany({
      where: { id: { in: body.managerIds! }, role: Role.MANAGER, status: UserStatus.ACTIVE },
    });
    if (managers.length !== body.managerIds!.length) {
      throw new ApiError("One or more managers are invalid or inactive", STATUS_CODES.BAD_REQUEST);
    }
    const orderedManagers = body.managerIds!.map((id) => managers.find((m) => m.id === id)!);

    return prisma.$transaction(async (tx) => {
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
      let lastUsedManagerId = cursor.lastAssignedManagerId;

      for (const lead of leads) {
        const manager = orderedManagers[position % managerIds.length]!;
        await this.assignLeadToManager(tx, lead, manager, adminId, AssignmentType.ROUND_ROBIN);
        lastUsedManagerId = manager.id;
        position++;
      }

      await tx.managerAssignmentRoundRobin.update({
        where: { id: cursor.id },
        data: { lastAssignedManagerId: lastUsedManagerId },
      });

      return { assignedCount: leads.length };
    });
  }

  async bulkAssignSalespersons(managerId: string, body: BulkAssignSalespersonBody) {
    const group = await prisma.group.findUnique({ where: { id: body.groupId } });
    if (!group || group.managerId !== managerId) {
      throw new ApiError("Group not found", STATUS_CODES.NOT_FOUND);
    }

    if (body.method === "MANUAL") {
      const salesperson = await prisma.user.findUnique({ where: { id: body.salespersonId! } });
      if (!salesperson || salesperson.role !== Role.SALESPERSON || salesperson.status !== UserStatus.ACTIVE) {
        throw new ApiError("Invalid or inactive salesperson", STATUS_CODES.BAD_REQUEST);
      }
      const membership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: body.groupId, userId: salesperson.id } },
      });
      if (!membership?.isActive) {
        throw new ApiError("Salesperson is not an active member of this group", STATUS_CODES.BAD_REQUEST);
      }

      return prisma.$transaction(async (tx) => {
        const leads = await this.fetchLeadsOrThrow(tx, body.leadIds);
        if (leads.some((lead) => lead.assignedManagerId !== managerId)) {
          throw new ApiError("One or more leads are not assigned to you", STATUS_CODES.FORBIDDEN);
        }
        for (const lead of leads) {
          await this.assignLeadToSalesperson(tx, lead, salesperson, body.groupId, managerId, AssignmentType.MANUAL);
        }
        return { assignedCount: leads.length };
      });
    }

    const members = await prisma.groupMember.findMany({
      where: { groupId: body.groupId, isActive: true, userId: { in: body.salespersonIds! } },
      include: { user: true },
    });
    if (members.length !== body.salespersonIds!.length) {
      throw new ApiError("One or more salespeople are not active members of this group", STATUS_CODES.BAD_REQUEST);
    }
    const orderedSalespeople = body.salespersonIds!.map((id) => members.find((m) => m.userId === id)!.user);

    return prisma.$transaction(async (tx) => {
      const configRows = await tx.$queryRaw<{ id: string; lastAssignedUserId: string | null }[]>`
        SELECT id, last_assigned_user_id AS "lastAssignedUserId"
        FROM group_assignment_configs
        WHERE group_id = ${body.groupId}::uuid
        FOR UPDATE
      `;

      let config = configRows[0];
      if (!config) {
        const created = await tx.groupAssignmentConfig.create({ data: { groupId: body.groupId, strategy: "ROUND_ROBIN" } });
        config = { id: created.id, lastAssignedUserId: created.lastAssignedUserId };
      }

      const salespersonIds = orderedSalespeople.map((s) => s.id);
      let position = 0;
      if (config.lastAssignedUserId) {
        const idx = salespersonIds.indexOf(config.lastAssignedUserId);
        position = idx === -1 ? 0 : (idx + 1) % salespersonIds.length;
      }

      const leads = await this.fetchLeadsOrThrow(tx, body.leadIds);
      if (leads.some((lead) => lead.assignedManagerId !== managerId)) {
        throw new ApiError("One or more leads are not assigned to you", STATUS_CODES.FORBIDDEN);
      }

      let lastUsedUserId = config.lastAssignedUserId;
      for (const lead of leads) {
        const salesperson = orderedSalespeople[position % salespersonIds.length]!;
        await this.assignLeadToSalesperson(tx, lead, salesperson, body.groupId, managerId, AssignmentType.ROUND_ROBIN);
        lastUsedUserId = salesperson.id;
        position++;
      }

      await tx.groupAssignmentConfig.update({ where: { id: config.id }, data: { lastAssignedUserId: lastUsedUserId } });

      return { assignedCount: leads.length };
    });
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

  async confirmImport(_user: AuthUser, batchId: string) {
    const batch = await prisma.leadImportBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new ApiError("Import batch not found", STATUS_CODES.NOT_FOUND);
    if (batch.status !== ImportBatchStatus.DRAFT) {
      throw new ApiError("Import batch already processed", STATUS_CODES.CONFLICT);
    }

    const rows = (batch.parsedRows as unknown as ParsedImportRow[]) ?? [];
    if (rows.length === 0) {
      throw new ApiError("No valid rows to import", STATUS_CODES.BAD_REQUEST);
    }

    const sourceCache = new Map<string, string>();
    const resolveSourceId = async (name: string | undefined): Promise<string | undefined> => {
      const sourceName = name?.trim() || "CSV Import";
      if (sourceCache.has(sourceName)) return sourceCache.get(sourceName);
      const source = await prisma.source.upsert({
        where: { code: sourceName.toUpperCase().replace(/\s+/g, "_") },
        update: {},
        create: { name: sourceName, code: sourceName.toUpperCase().replace(/\s+/g, "_") },
      });
      sourceCache.set(sourceName, source.id);
      return source.id;
    };

    const chunkSize = 200;
    let createdCount = 0;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      await prisma.$transaction(async (tx) => {
        for (const row of chunk) {
          const sourceId = await resolveSourceId(row.sourceName);
          const lead = await this.createLeadWithUniqueNumber(
            {
              firstName: row.firstName,
              lastName: row.lastName,
              mobile: row.mobile,
              normalizedMobile: row.normalizedMobile,
              email: row.email,
              normalizedEmail: row.normalizedEmail,
              requirement: row.requirement,
              location: row.location,
              sourceId,
              importBatchId: batch.id,
            },
            tx,
          );
          await tx.activity.create({
            data: {
              leadId: lead.id,
              type: ActivityType.LEAD_CREATED,
              referenceType: "LeadImportBatch",
              referenceId: batch.id,
              title: "Lead created via CSV import",
            },
          });
          createdCount++;
        }
      });
    }

    await prisma.leadImportBatch.update({
      where: { id: batch.id },
      data: { status: ImportBatchStatus.COMMITTED, committedAt: new Date(), parsedRows: Prisma.DbNull },
    });

    return { batchId: batch.id, createdCount };
  }

  async getImportBatch(_user: AuthUser, batchId: string) {
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
      },
    });
    if (!batch) throw new ApiError("Import batch not found", STATUS_CODES.NOT_FOUND);
    return batch;
  }
}

export default LeadService;
