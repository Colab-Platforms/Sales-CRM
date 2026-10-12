import { prisma } from "@/lib/prisma.js";
import { hashPassword } from "@/lib/password.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role, UserStatus, GroupStatus } from "../../../generated/prisma/enums.js";
import type {
  CreateManagerBody,
  CreateSalespersonBody,
  UpdateManagerBody,
  UpdateSalespersonBody,
  CreateHrBody,
  CreateGroupBody,
  UpdateGroupBody,
  AddSalespersonBody,
  AddExistingMemberBody,
} from "./admin.types.js";

function toPublicUser(user: { id: string; name: string; username: string; phone: string | null; role: string; status: string }) {
  return { id: user.id, name: user.name, username: user.username, phone: user.phone, role: user.role, status: user.status };
}

class AdminService {
  async createManager(data: CreateManagerBody) {
    const existing = await prisma.user.findUnique({ where: { username: data.username } });
    if (existing) {
      throw new ApiError("Username already in use", STATUS_CODES.CONFLICT);
    }

    const passwordHash = await hashPassword(data.password);

    const manager = await prisma.user.create({
      data: {
        name: data.name,
        username: data.username,
        phone: data.phone,
        passwordHash,
        role: Role.MANAGER,
        status: UserStatus.ACTIVE,
      },
    });

    return toPublicUser(manager);
  }

  async listManagers() {
    const managers = await prisma.user.findMany({
      where: { role: Role.MANAGER },
      orderBy: { createdAt: "desc" },
    });
    return managers.map(toPublicUser);
  }

  private async getManagerOrThrow(id: string) {
    const manager = await prisma.user.findUnique({ where: { id } });
    if (!manager || manager.role !== Role.MANAGER) {
      throw new ApiError("Manager not found", STATUS_CODES.NOT_FOUND);
    }
    return manager;
  }

  async getManagerById(id: string) {
    const manager = await this.getManagerOrThrow(id);
    return toPublicUser(manager);
  }

  async updateManager(id: string, data: UpdateManagerBody) {
    await this.getManagerOrThrow(id);

    const manager = await prisma.user.update({
      where: { id },
      data: {
        name: data.name,
        phone: data.phone,
        status: data.status,
      },
    });

    return toPublicUser(manager);
  }

  async deactivateManager(id: string) {
    await this.getManagerOrThrow(id);

    const manager = await prisma.user.update({
      where: { id },
      data: { status: UserStatus.INACTIVE },
    });

    return toPublicUser(manager);
  }

  async resetManagerPassword(id: string, password: string) {
    await this.getManagerOrThrow(id);

    const passwordHash = await hashPassword(password);
    const manager = await prisma.user.update({
      where: { id },
      data: { passwordHash },
    });

    return toPublicUser(manager);
  }

  // Admin picks the reporting manager up front — from that point on, only that
  // manager (not every manager) can see this salesperson or add them to a team.
  async createSalesperson(adminId: string, data: CreateSalespersonBody) {
    const manager = await this.getManagerOrThrow(data.reportingManagerId);
    if (manager.status !== UserStatus.ACTIVE) {
      throw new ApiError("Reporting manager is not active", STATUS_CODES.BAD_REQUEST);
    }

    const existing = await prisma.user.findUnique({ where: { username: data.username } });
    if (existing) {
      throw new ApiError("Username already in use", STATUS_CODES.CONFLICT);
    }

    const passwordHash = await hashPassword(data.password);

    const salesperson = await prisma.user.create({
      data: {
        name: data.name,
        username: data.username,
        phone: data.phone,
        passwordHash,
        role: Role.SALESPERSON,
        status: UserStatus.ACTIVE,
        reportingManagerId: data.reportingManagerId,
        createdById: adminId,
      },
    });

    return toPublicUser(salesperson);
  }

  async listSalespersons() {
    const salespersons = await prisma.user.findMany({
      where: { role: Role.SALESPERSON },
      include: { reportingManager: { select: { id: true, name: true, username: true } } },
      orderBy: { createdAt: "desc" },
    });

    return salespersons.map((sp) => ({ ...toPublicUser(sp), reportingManager: sp.reportingManager }));
  }

  private async getSalespersonOrThrow(id: string) {
    const salesperson = await prisma.user.findUnique({ where: { id } });
    if (!salesperson || salesperson.role !== Role.SALESPERSON) {
      throw new ApiError("Salesperson not found", STATUS_CODES.NOT_FOUND);
    }
    return salesperson;
  }

  async updateSalesperson(id: string, data: UpdateSalespersonBody) {
    const existing = await this.getSalespersonOrThrow(id);
    const isReassignment =
      data.reportingManagerId !== undefined && data.reportingManagerId !== existing.reportingManagerId;

    if (isReassignment) {
      const manager = await this.getManagerOrThrow(data.reportingManagerId as string);
      if (manager.status !== UserStatus.ACTIVE) {
        throw new ApiError("Reporting manager is not active", STATUS_CODES.BAD_REQUEST);
      }
    }

    const salesperson = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          name: data.name,
          phone: data.phone,
          status: data.status,
          reportingManagerId: data.reportingManagerId,
        },
        include: { reportingManager: { select: { id: true, name: true, username: true } } },
      });

      if (isReassignment) {
        // Old manager loses visibility entirely — including any group they'd
        // already placed this salesperson in.
        await tx.groupMember.updateMany({
          where: { userId: id, isActive: true, group: { managerId: { not: data.reportingManagerId } } },
          data: { isActive: false },
        });
      }

      return updated;
    });

    return { ...toPublicUser(salesperson), reportingManager: salesperson.reportingManager };
  }

  async resetSalespersonPassword(id: string, password: string) {
    await this.getSalespersonOrThrow(id);

    const passwordHash = await hashPassword(password);
    const salesperson = await prisma.user.update({
      where: { id },
      data: { passwordHash },
    });

    return toPublicUser(salesperson);
  }

  async createHr(data: CreateHrBody) {
    const existing = await prisma.user.findUnique({ where: { username: data.username } });
    if (existing) {
      throw new ApiError("Username already in use", STATUS_CODES.CONFLICT);
    }

    const passwordHash = await hashPassword(data.password);

    const hr = await prisma.user.create({
      data: {
        name: data.name,
        username: data.username,
        phone: data.phone,
        passwordHash,
        role: Role.HR,
        status: UserStatus.ACTIVE,
      },
    });

    return toPublicUser(hr);
  }

  async listHr() {
    const hrUsers = await prisma.user.findMany({
      where: { role: Role.HR },
      orderBy: { createdAt: "desc" },
    });
    return hrUsers.map(toPublicUser);
  }

  // Org-wide group (team) management. Unlike manager.service's getOwnedGroup,
  // this never checks who manages the group — admin/HR can act on any of them.
  private async getGroupOrThrow(groupId: string) {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) {
      throw new ApiError("Group not found", STATUS_CODES.NOT_FOUND);
    }
    return group;
  }

  async createGroup(data: CreateGroupBody) {
    const manager = await this.getManagerOrThrow(data.managerId);
    if (manager.status !== UserStatus.ACTIVE) {
      throw new ApiError("Manager is not active", STATUS_CODES.BAD_REQUEST);
    }

    return prisma.group.create({
      data: {
        name: data.name,
        description: data.description,
        managerId: data.managerId,
        status: GroupStatus.ACTIVE,
      },
    });
  }

  async listGroups() {
    return prisma.group.findMany({
      include: {
        manager: { select: { id: true, name: true, username: true } },
        members: {
          where: { isActive: true },
          include: { user: { select: { id: true, name: true, username: true, phone: true, status: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async getGroupById(groupId: string) {
    await this.getGroupOrThrow(groupId);

    return prisma.group.findUnique({
      where: { id: groupId },
      include: {
        manager: { select: { id: true, name: true, username: true } },
        members: {
          where: { isActive: true },
          include: { user: { select: { id: true, name: true, username: true, phone: true, status: true } } },
        },
      },
    });
  }

  async updateGroup(groupId: string, data: UpdateGroupBody) {
    await this.getGroupOrThrow(groupId);

    if (data.managerId) {
      const manager = await this.getManagerOrThrow(data.managerId);
      if (manager.status !== UserStatus.ACTIVE) {
        throw new ApiError("Manager is not active", STATUS_CODES.BAD_REQUEST);
      }
    }

    return prisma.group.update({
      where: { id: groupId },
      data: {
        name: data.name,
        description: data.description,
        status: data.status,
        managerId: data.managerId,
      },
    });
  }

  async deleteGroup(groupId: string) {
    await this.getGroupOrThrow(groupId);

    return prisma.group.update({
      where: { id: groupId },
      data: { status: GroupStatus.INACTIVE },
    });
  }

  async addNewSalesperson(groupId: string, adminId: string, data: AddSalespersonBody) {
    const group = await this.getGroupOrThrow(groupId);

    const existing = await prisma.user.findUnique({ where: { username: data.username } });
    if (existing) {
      throw new ApiError("Username already in use", STATUS_CODES.CONFLICT);
    }

    const passwordHash = await hashPassword(data.password);

    const salesperson = await prisma.user.create({
      data: {
        name: data.name,
        username: data.username,
        phone: data.phone,
        passwordHash,
        role: Role.SALESPERSON,
        status: UserStatus.ACTIVE,
        reportingManagerId: group.managerId,
        createdById: adminId,
      },
    });

    await prisma.groupMember.create({
      data: { groupId: group.id, userId: salesperson.id, joinedAt: new Date(), isActive: true },
    });

    return toPublicUser(salesperson);
  }

  async addExistingSalesperson(groupId: string, data: AddExistingMemberBody) {
    const group = await this.getGroupOrThrow(groupId);

    const user = await this.getSalespersonOrThrow(data.userId);

    const existingMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: user.id } },
    });

    await prisma.$transaction(async (tx) => {
      if (existingMembership) {
        if (existingMembership.isActive) {
          throw new ApiError("Salesperson already in group", STATUS_CODES.CONFLICT);
        }
        await tx.groupMember.update({
          where: { id: existingMembership.id },
          data: { isActive: true, joinedAt: new Date() },
        });
      } else {
        await tx.groupMember.create({
          data: { groupId: group.id, userId: user.id, joinedAt: new Date(), isActive: true },
        });
      }

      if (user.reportingManagerId !== group.managerId) {
        // Moving a salesperson into a group owned by a different manager hands
        // visibility to that manager — the old manager loses this salesperson
        // entirely, including any group they'd already placed them in.
        await tx.user.update({ where: { id: user.id }, data: { reportingManagerId: group.managerId } });
        await tx.groupMember.updateMany({
          where: { userId: user.id, isActive: true, group: { managerId: { not: group.managerId } } },
          data: { isActive: false },
        });
      }
    });

    return toPublicUser(user);
  }

  async removeSalesperson(groupId: string, userId: string) {
    const group = await this.getGroupOrThrow(groupId);

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId } },
    });

    if (!membership || !membership.isActive) {
      throw new ApiError("Salesperson not found in this group", STATUS_CODES.NOT_FOUND);
    }

    await prisma.groupMember.update({
      where: { id: membership.id },
      data: { isActive: false },
    });
  }
}

export default AdminService;
