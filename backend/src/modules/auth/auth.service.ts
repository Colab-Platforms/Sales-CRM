import { prisma } from "@/lib/prisma.js";
import { comparePassword } from "@/lib/password.js";
import { signToken } from "@/lib/jwt.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import type { LoginBody } from "./auth.types.js";

function toPublicUser(user: { id: string; name: string; email: string; role: string; status: string }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status };
}

class AuthService {
  async login(data: LoginBody) {
    const user = await prisma.user.findUnique({ where: { email: data.email } });

    if (!user || !user.passwordHash) {
      throw new ApiError("Invalid email or password", STATUS_CODES.UNAUTHORIZED);
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new ApiError("Account is inactive", STATUS_CODES.FORBIDDEN);
    }

    const isPasswordValid = await comparePassword(data.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new ApiError("Invalid email or password", STATUS_CODES.UNAUTHORIZED);
    }

    const accessToken = signToken({ sub: user.id, role: user.role, email: user.email });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return { user: toPublicUser(user), accessToken };
  }

  async getCurrentUser(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new ApiError("User not found", STATUS_CODES.NOT_FOUND);
    }
    return toPublicUser(user);
  }

  // Role-aware profile: the same "who am I" question, but with the context
  // each role actually cares about — a salesperson's reporting manager and
  // teams, a manager's groups and headcount, or an admin's org-wide totals.
  async getProfile(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new ApiError("User not found", STATUS_CODES.NOT_FOUND);
    }

    const base = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    };

    if (user.role === Role.SALESPERSON) {
      const [reportingManager, memberships, totalLeads] = await Promise.all([
        user.reportingManagerId
          ? prisma.user.findUnique({
              where: { id: user.reportingManagerId },
              select: { id: true, name: true, email: true, phone: true },
            })
          : null,
        prisma.groupMember.findMany({
          where: { userId: user.id, isActive: true },
          include: { group: { select: { id: true, name: true, status: true } } },
          orderBy: { joinedAt: "desc" },
        }),
        prisma.lead.count({ where: { ownerId: user.id } }),
      ]);

      return {
        ...base,
        reportingManager,
        teams: memberships.map((m) => ({
          id: m.group.id,
          name: m.group.name,
          status: m.group.status,
          joinedAt: m.joinedAt,
        })),
        stats: { totalLeads },
      };
    }

    if (user.role === Role.MANAGER) {
      const groups = await prisma.group.findMany({
        where: { managerId: user.id },
        include: { members: { where: { isActive: true }, select: { userId: true } } },
        orderBy: { createdAt: "desc" },
      });
      const teamMemberIds = new Set(groups.flatMap((g) => g.members.map((m) => m.userId)));
      const totalLeads = await prisma.lead.count({ where: { assignedManagerId: user.id } });

      return {
        ...base,
        groups: groups.map((g) => ({ id: g.id, name: g.name, status: g.status, memberCount: g.members.length })),
        teamMemberCount: teamMemberIds.size,
        stats: { totalLeads },
      };
    }

    const [usersByRole, totalGroups, totalLeads] = await Promise.all([
      prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
      prisma.group.count(),
      prisma.lead.count(),
    ]);

    return {
      ...base,
      orgOverview: {
        totalManagers: usersByRole.find((r) => r.role === Role.MANAGER)?._count._all ?? 0,
        totalSalespersons: usersByRole.find((r) => r.role === Role.SALESPERSON)?._count._all ?? 0,
        totalGroups,
        totalLeads,
      },
    };
  }
}

export default AuthService;
