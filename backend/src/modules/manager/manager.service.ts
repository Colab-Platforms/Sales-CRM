import { prisma } from "@/lib/prisma.js";
import { hashPassword } from "@/lib/password.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role, UserStatus, GroupStatus } from "../../../generated/prisma/enums.js";
import type {
  CreateGroupBody,
  AddSalespersonBody,
  AddExistingMemberBody,
  UpdateGroupBody,
  UpdateSalespersonBody,
} from "./manager.types.js";

function toPublicUser(user: { id: string; name: string; email: string; phone: string | null; role: string; status: string }) {
  return { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, status: user.status };
}

class ManagerService {
  private async getOwnedGroup(managerId: string, groupId: string) {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group || group.managerId !== managerId) {
      throw new ApiError("Group not found", STATUS_CODES.NOT_FOUND);
    }
    return group;
  }

  async createGroup(managerId: string, data: CreateGroupBody) {
    const group = await prisma.group.create({
      data: {
        name: data.name,
        description: data.description,
        managerId,
        status: GroupStatus.ACTIVE,
      },
    });
    return group;
  }

  async listMyGroups(managerId: string) {
    return prisma.group.findMany({
      where: { managerId },
      include: {
        members: {
          where: { isActive: true },
          include: { user: { select: { id: true, name: true, email: true, phone: true, status: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async getGroupById(managerId: string, groupId: string) {
    await this.getOwnedGroup(managerId, groupId);

    return prisma.group.findUnique({
      where: { id: groupId },
      include: {
        members: {
          where: { isActive: true },
          include: { user: { select: { id: true, name: true, email: true, phone: true, status: true } } },
        },
      },
    });
  }

  async updateGroup(managerId: string, groupId: string, data: UpdateGroupBody) {
    await this.getOwnedGroup(managerId, groupId);

    return prisma.group.update({
      where: { id: groupId },
      data: {
        name: data.name,
        description: data.description,
        status: data.status,
      },
    });
  }

  async deleteGroup(managerId: string, groupId: string) {
    await this.getOwnedGroup(managerId, groupId);

    return prisma.group.update({
      where: { id: groupId },
      data: { status: GroupStatus.INACTIVE },
    });
  }

  async addNewSalesperson(managerId: string, groupId: string, data: AddSalespersonBody) {
    const group = await this.getOwnedGroup(managerId, groupId);

    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      throw new ApiError("Email already in use", STATUS_CODES.CONFLICT);
    }

    const passwordHash = await hashPassword(data.password);

    const salesperson = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        passwordHash,
        role: Role.SALESPERSON,
        status: UserStatus.ACTIVE,
        reportingManagerId: managerId,
        createdById: managerId,
      },
    });

    await prisma.groupMember.create({
      data: { groupId: group.id, userId: salesperson.id, joinedAt: new Date(), isActive: true },
    });

    return toPublicUser(salesperson);
  }

  // Everyone reporting to this manager — whether the manager grouped them
  // themselves or admin assigned them as reporting manager — with their current
  // active group attached if they have one. Salespeople admin just assigned but
  // that the manager hasn't placed in a group yet show up with groupId: null,
  // so they're visible immediately instead of being invisible until someone
  // remembers to add them via "Add existing salesperson". Lead-assignment
  // pickers filter this same list down to grouped entries, since a lead
  // assignment always needs a group to attach to.
  async listMySalespersons(managerId: string) {
    const salespersons = await prisma.user.findMany({
      where: { role: Role.SALESPERSON, status: UserStatus.ACTIVE, reportingManagerId: managerId },
      select: { id: true, name: true, email: true, phone: true, status: true, role: true },
      orderBy: { name: "asc" },
    });

    const memberships = await prisma.groupMember.findMany({
      where: {
        isActive: true,
        userId: { in: salespersons.map((sp) => sp.id) },
        group: { managerId, status: GroupStatus.ACTIVE },
      },
      include: { group: { select: { id: true, name: true } } },
    });
    const groupByUserId = new Map(memberships.map((m) => [m.userId, m.group]));

    return salespersons.map((sp) => {
      const group = groupByUserId.get(sp.id);
      return { ...toPublicUser(sp), groupId: group?.id ?? null, groupName: group?.name ?? null };
    });
  }

  // Salespeople reporting to this manager — either created by the manager
  // themselves, or created by admin with this manager picked as reporting
  // manager. This is the candidate pool for "add existing salesperson"; it must
  // never include salespeople reporting to a different manager.
  async listAllSalespersons(managerId: string) {
    const salespersons = await prisma.user.findMany({
      where: { role: Role.SALESPERSON, reportingManagerId: managerId },
      include: {
        groupMemberships: {
          where: { isActive: true },
          include: { group: { select: { id: true, name: true } } },
        },
      },
      orderBy: { name: "asc" },
    });

    return salespersons.map((sp) => ({
      ...toPublicUser(sp),
      currentGroup: sp.groupMemberships[0]?.group ?? null,
    }));
  }

  async addExistingSalesperson(managerId: string, groupId: string, data: AddExistingMemberBody) {
    const group = await this.getOwnedGroup(managerId, groupId);

    const user = await prisma.user.findUnique({ where: { id: data.userId } });
    if (!user || user.role !== Role.SALESPERSON || user.reportingManagerId !== managerId) {
      throw new ApiError("Salesperson not found", STATUS_CODES.NOT_FOUND);
    }

    const existingMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: user.id } },
    });

    if (existingMembership) {
      if (existingMembership.isActive) {
        throw new ApiError("Salesperson already in group", STATUS_CODES.CONFLICT);
      }
      await prisma.groupMember.update({
        where: { id: existingMembership.id },
        data: { isActive: true, joinedAt: new Date() },
      });
    } else {
      await prisma.groupMember.create({
        data: { groupId: group.id, userId: user.id, joinedAt: new Date(), isActive: true },
      });
    }

    return toPublicUser(user);
  }

  private async getActiveMembership(managerId: string, groupId: string, userId: string) {
    const group = await this.getOwnedGroup(managerId, groupId);

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId } },
    });

    if (!membership || !membership.isActive) {
      throw new ApiError("Salesperson not found in this group", STATUS_CODES.NOT_FOUND);
    }

    return membership;
  }

  async updateSalesperson(managerId: string, groupId: string, userId: string, data: UpdateSalespersonBody) {
    await this.getActiveMembership(managerId, groupId, userId);

    const salesperson = await prisma.user.update({
      where: { id: userId },
      data: {
        name: data.name,
        phone: data.phone,
        status: data.status,
      },
    });

    return toPublicUser(salesperson);
  }

  async removeSalesperson(managerId: string, groupId: string, userId: string) {
    const membership = await this.getActiveMembership(managerId, groupId, userId);

    await prisma.groupMember.update({
      where: { id: membership.id },
      data: { isActive: false },
    });
  }
}

export default ManagerService;
