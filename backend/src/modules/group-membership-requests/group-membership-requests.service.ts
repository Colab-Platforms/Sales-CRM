// Manager requests to add an existing salesperson to one of their own groups,
// decided by Admin/HR (request -> approve/reject). There is no separate execution
// phase like refunds: APPROVED performs the group-membership add in the same
// transaction as the decision, so a failure (e.g. the salesperson was deactivated
// meanwhile) rolls the decision back too and the request stays PENDING, decidable again.
import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import {
  ActivitySource,
  ActivityType,
  GroupMembershipRequestStatus,
  Role,
  UserStatus,
} from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { AuthUser } from "@/middlewares/auth.js";
import type { CreateMembershipRequestBody, ListMembershipRequestsQuery } from "./group-membership-requests.types.js";

const APPROVER_ROLES = new Set<Role>([Role.ADMIN, Role.HR]);

const REQUEST_SELECT = {
  id: true,
  groupId: true,
  salespersonId: true,
  requestedById: true,
  requestedByRole: true,
  requestNote: true,
  status: true,
  decidedById: true,
  decidedByRole: true,
  decisionAt: true,
  decisionNote: true,
  createdAt: true,
  group: { select: { id: true, name: true, managerId: true, status: true } },
  salesperson: { select: { id: true, name: true, username: true, status: true, reportingManagerId: true } },
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
} satisfies Prisma.GroupMembershipRequestSelect;

type RequestRow = Prisma.GroupMembershipRequestGetPayload<{ select: typeof REQUEST_SELECT }>;

function toView(row: RequestRow) {
  return {
    id: row.id,
    group: { id: row.group.id, name: row.group.name, managerId: row.group.managerId, status: row.group.status },
    salesperson: { id: row.salesperson.id, name: row.salesperson.name, username: row.salesperson.username },
    requestedBy: { id: row.requestedBy.id, name: row.requestedBy.name, role: row.requestedByRole },
    requestNote: row.requestNote,
    status: row.status,
    decidedBy: row.decidedBy && row.decidedByRole ? { id: row.decidedBy.id, name: row.decidedBy.name, role: row.decidedByRole } : null,
    decisionAt: row.decisionAt,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt,
  };
}

class GroupMembershipRequestsService {
  /** A manager requests adding one of their own direct reports to one of their own groups. */
  async createRequest(user: AuthUser, input: CreateMembershipRequestBody) {
    if (user.role !== Role.MANAGER) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);

    const group = await prisma.group.findUnique({ where: { id: input.groupId } });
    if (!group || group.managerId !== user.id) throw new ApiError("Group not found", STATUS_CODES.NOT_FOUND);
    if (group.status !== "ACTIVE") throw new ApiError("This group is not active", STATUS_CODES.BAD_REQUEST);

    const salesperson = await prisma.user.findUnique({ where: { id: input.salespersonId } });
    if (!salesperson || salesperson.role !== Role.SALESPERSON || salesperson.reportingManagerId !== user.id) {
      throw new ApiError("Salesperson not found", STATUS_CODES.NOT_FOUND);
    }
    if (salesperson.status !== UserStatus.ACTIVE) throw new ApiError("This salesperson is not active", STATUS_CODES.BAD_REQUEST);

    const existingMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: salesperson.id } },
    });
    if (existingMembership?.isActive) throw new ApiError("Salesperson already in group", STATUS_CODES.CONFLICT);

    const existingPending = await prisma.groupMembershipRequest.findFirst({
      where: { groupId: group.id, salespersonId: salesperson.id, status: GroupMembershipRequestStatus.PENDING },
    });
    if (existingPending) throw new ApiError("A request for this salesperson and group is already pending", STATUS_CODES.CONFLICT);

    const note = input.note?.trim() || null;

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.groupMembershipRequest.create({
        data: {
          groupId: group.id,
          salespersonId: salesperson.id,
          requestedById: user.id,
          requestedByRole: user.role,
          requestNote: note,
          status: GroupMembershipRequestStatus.PENDING,
        },
        select: REQUEST_SELECT,
      });
      await tx.activity.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          type: ActivityType.GROUP_MEMBERSHIP_REQUESTED,
          referenceType: "GroupMembershipRequest",
          referenceId: row.id,
          source: ActivitySource.USER,
          title: `Requested to add ${salesperson.name} to ${group.name}`,
          description: note,
          newValue: { status: GroupMembershipRequestStatus.PENDING } as Prisma.InputJsonValue,
          metadata: { groupId: group.id, salespersonId: salesperson.id } as Prisma.InputJsonValue,
        },
      });
      return row;
    });

    return toView(created);
  }

  /** Manager sees their own requests; Admin/HR see every request (the approval queue + history). */
  async list(user: AuthUser, query: ListMembershipRequestsQuery) {
    if (user.role !== Role.MANAGER && !APPROVER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);

    const where: Prisma.GroupMembershipRequestWhereInput = {
      ...(user.role === Role.MANAGER ? { requestedById: user.id } : {}),
      ...(query.status !== "ALL" ? { status: query.status } : {}),
    };

    const rows = await prisma.groupMembershipRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: REQUEST_SELECT,
    });
    return rows.map(toView);
  }

  /** Pending count for the Admin/HR sidebar badge. */
  async pendingCount(user: AuthUser) {
    if (!APPROVER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    const count = await prisma.groupMembershipRequest.count({ where: { status: GroupMembershipRequestStatus.PENDING } });
    return { count };
  }

  async approve(user: AuthUser, id: string, note?: string) {
    return this.decide(user, id, GroupMembershipRequestStatus.APPROVED, note?.trim() || null);
  }

  async reject(user: AuthUser, id: string, note: string) {
    return this.decide(user, id, GroupMembershipRequestStatus.REJECTED, note.trim());
  }

  private async decide(user: AuthUser, id: string, to: "APPROVED" | "REJECTED", note: string | null) {
    if (!APPROVER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);

    return prisma.$transaction(async (tx) => {
      const found = await tx.groupMembershipRequest.findUnique({ where: { id }, select: REQUEST_SELECT });
      if (!found) throw new ApiError("Request not found", STATUS_CODES.NOT_FOUND);
      if (found.status !== GroupMembershipRequestStatus.PENDING) {
        throw new ApiError(`This request was already ${found.status.toLowerCase()}. A decision can not be changed.`, STATUS_CODES.CONFLICT);
      }

      if (to === "APPROVED") {
        const salesperson = await tx.user.findUniqueOrThrow({ where: { id: found.salespersonId } });
        if (salesperson.role !== Role.SALESPERSON || salesperson.status !== UserStatus.ACTIVE) {
          throw new ApiError("This salesperson is no longer active, so the request was NOT approved.", STATUS_CODES.CONFLICT);
        }
        const groupRow = await tx.group.findUniqueOrThrow({ where: { id: found.groupId } });
        if (groupRow.status !== "ACTIVE") {
          throw new ApiError("This group is no longer active, so the request was NOT approved.", STATUS_CODES.CONFLICT);
        }

        const existingMembership = await tx.groupMember.findUnique({
          where: { groupId_userId: { groupId: groupRow.id, userId: salesperson.id } },
        });
        if (existingMembership) {
          if (existingMembership.isActive) throw new ApiError("Salesperson already in group", STATUS_CODES.CONFLICT);
          await tx.groupMember.update({ where: { id: existingMembership.id }, data: { isActive: true, joinedAt: new Date() } });
        } else {
          await tx.groupMember.create({ data: { groupId: groupRow.id, userId: salesperson.id, joinedAt: new Date(), isActive: true } });
        }

        if (salesperson.reportingManagerId !== groupRow.managerId) {
          // The group's manager may have changed since the request was raised - hand
          // visibility to the group's current manager, same as admin's direct add.
          await tx.user.update({ where: { id: salesperson.id }, data: { reportingManagerId: groupRow.managerId } });
          await tx.groupMember.updateMany({
            where: { userId: salesperson.id, isActive: true, group: { managerId: { not: groupRow.managerId } } },
            data: { isActive: false },
          });
        }
      }

      const { count } = await tx.groupMembershipRequest.updateMany({
        where: { id, status: GroupMembershipRequestStatus.PENDING },
        data: { status: to, decidedById: user.id, decidedByRole: user.role, decisionAt: new Date(), decisionNote: note },
      });
      if (count === 0) throw new ApiError("This request was already decided. A decision can not be changed.", STATUS_CODES.CONFLICT);

      await tx.activity.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          type: to === "APPROVED" ? ActivityType.GROUP_MEMBERSHIP_APPROVED : ActivityType.GROUP_MEMBERSHIP_REJECTED,
          referenceType: "GroupMembershipRequest",
          referenceId: id,
          source: ActivitySource.USER,
          title:
            to === "APPROVED"
              ? `Approved adding ${found.salesperson.name} to ${found.group.name}`
              : `Rejected adding ${found.salesperson.name} to ${found.group.name}`,
          description: note,
          oldValue: { status: GroupMembershipRequestStatus.PENDING } as Prisma.InputJsonValue,
          newValue: { status: to } as Prisma.InputJsonValue,
          metadata: { groupId: found.groupId, salespersonId: found.salespersonId, requestedById: found.requestedById } as Prisma.InputJsonValue,
        },
      });

      const updated = await tx.groupMembershipRequest.findUniqueOrThrow({ where: { id }, select: REQUEST_SELECT });
      return toView(updated);
    });
  }
}

export default GroupMembershipRequestsService;
