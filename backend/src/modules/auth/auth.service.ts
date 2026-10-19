import { prisma } from "@/lib/prisma.js";
import { comparePassword } from "@/lib/password.js";
import { signToken } from "@/lib/jwt.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import type { LoginBody } from "./auth.types.js";
import { generateRefreshToken, hashRefreshToken, refreshTtlMs, ROTATION_GRACE_MS } from "@/lib/refreshToken.js";
import { randomUUID } from "node:crypto";

export interface IssuedSession {
  user: ReturnType<typeof toPublicUser>;
  accessToken: string;
  /** null when the caller must keep the cookie it already has (parallel-refresh grace). */
  refreshToken: string | null;
}

function toPublicUser(user: { id: string; name: string; username: string; role: string; status: string }) {
  return { id: user.id, name: user.name, username: user.username, role: user.role, status: user.status };
}

class AuthService {
  async login(data: LoginBody, userAgent?: string): Promise<IssuedSession> {
    const user = await prisma.user.findUnique({ where: { username: data.username } });

    if (!user || !user.passwordHash) {
      throw new ApiError("Invalid username or password", STATUS_CODES.UNAUTHORIZED);
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new ApiError("Account is inactive", STATUS_CODES.FORBIDDEN);
    }

    const isPasswordValid = await comparePassword(data.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new ApiError("Invalid username or password", STATUS_CODES.UNAUTHORIZED);
    }

    const accessToken = signToken({ sub: user.id, role: user.role, username: user.username });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const refreshToken = await this.issueRefreshToken(user.id, randomUUID(), userAgent);
    // Lazy housekeeping: this user's long-expired rows are of no use to anyone.
    await prisma.refreshToken.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date(Date.now() - 86_400_000) } } }).catch(() => {});

    return { user: toPublicUser(user), accessToken, refreshToken };
  }

  private async issueRefreshToken(userId: string, familyId: string, userAgent?: string): Promise<string> {
    const { token, hash } = generateRefreshToken();
    await prisma.refreshToken.create({
      data: { userId, familyId, tokenHash: hash, expiresAt: new Date(Date.now() + refreshTtlMs()), userAgent: userAgent?.slice(0, 255) },
    });
    return token;
  }

  /**
   * Exchanges a refresh token for a new access token and a NEW refresh token (rotation). The presented token dies on use.
   * Showing a dead token again outside the race grace means it was copied: the whole login (family) is revoked.
   */
  async refreshSession(rawToken: string, userAgent?: string): Promise<IssuedSession> {
    const reject = (message = "Session expired. Please sign in again.") => new ApiError(message, STATUS_CODES.UNAUTHORIZED);
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(rawToken) }, include: { user: true } });
    if (!row) throw reject();

    const now = new Date();
    const revokeFamily = () => prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: now } });

    if (row.user.status !== UserStatus.ACTIVE) {
      await prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: now } });
      throw reject("Account is inactive");
    }
    if (row.expiresAt <= now) throw reject();

    const accessToken = signToken({ sub: row.user.id, role: row.user.role, username: row.user.username });

    // Lost a race (or already rotated): inside the grace it's a parallel tab, so hand out an access token only and leave the
    // browser's newer cookie alone. Outside it, treat as theft.
    const withinGrace = row.revokedAt !== null && row.rotatedAt !== null && now.getTime() - row.rotatedAt.getTime() <= ROTATION_GRACE_MS;
    if (row.revokedAt) {
      if (!withinGrace) {
        await revokeFamily();
        throw reject();
      }
      return { user: toPublicUser(row.user), accessToken, refreshToken: null };
    }

    const claimed = await prisma.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: now, rotatedAt: now } });
    if (claimed.count === 0) return { user: toPublicUser(row.user), accessToken, refreshToken: null };

    const refreshToken = await this.issueRefreshToken(row.userId, row.familyId, userAgent);
    return { user: toPublicUser(row.user), accessToken, refreshToken };
  }

  /** Ends this login on the server: the refresh cookie (and any copy of it) stops working. Unknown tokens are ignored. */
  async logout(rawToken: string | null): Promise<void> {
    if (!rawToken) return;
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(rawToken) }, select: { familyId: true } });
    if (row) await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
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
      username: user.username,
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
              select: { id: true, name: true, username: true, phone: true },
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

    if (user.role === Role.RECRUITER) {
      const totalApplications = await prisma.application.count({ where: { recruiterId: user.id } });
      return { ...base, stats: { totalApplications } };
    }

    if (user.role === Role.HR) {
      const [usersByRole, totalGroups] = await Promise.all([
        prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
        prisma.group.count(),
      ]);

      return {
        ...base,
        orgOverview: {
          totalManagers: usersByRole.find((r) => r.role === Role.MANAGER)?._count._all ?? 0,
          totalSalespersons: usersByRole.find((r) => r.role === Role.SALESPERSON)?._count._all ?? 0,
          totalGroups,
        },
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
