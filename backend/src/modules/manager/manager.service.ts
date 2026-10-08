import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role, UserStatus, GroupStatus } from "../../../generated/prisma/enums.js";

function toPublicUser(user: { id: string; name: string; username: string; phone: string | null; role: string; status: string }) {
  return { id: user.id, name: user.name, username: user.username, phone: user.phone, role: user.role, status: user.status };
}

class ManagerService {
  private async getOwnedGroup(managerId: string, groupId: string) {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group || group.managerId !== managerId) {
      throw new ApiError("Group not found", STATUS_CODES.NOT_FOUND);
    }
    return group;
  }

  async listMyGroups(managerId: string) {
    return prisma.group.findMany({
      where: { managerId },
      include: {
        members: {
          where: { isActive: true },
          include: { user: { select: { id: true, name: true, username: true, phone: true, status: true } } },
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
          include: { user: { select: { id: true, name: true, username: true, phone: true, status: true } } },
        },
      },
    });
  }

  // Everyone reporting to this manager — whether the manager grouped them
  // themselves or admin assigned them as reporting manager — with their current
  // active group attached if they have one. Salespeople admin just assigned but
  // that haven't been placed in a group yet show up with groupId: null, so
  // they're visible immediately instead of being invisible until someone
  // remembers to add them.
  async listMySalespersons(managerId: string) {
    const salespersons = await prisma.user.findMany({
      where: { role: Role.SALESPERSON, status: UserStatus.ACTIVE, reportingManagerId: managerId },
      select: { id: true, name: true, username: true, phone: true, status: true, role: true },
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
}

export default ManagerService;
