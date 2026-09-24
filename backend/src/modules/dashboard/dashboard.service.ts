import { prisma } from "@/lib/prisma.js";
import { Role, LeadWorkingStatus } from "../../../generated/prisma/enums.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { statusForRole } from "@/lib/leadStatusView.js";

type StatusCounts = Record<LeadWorkingStatus, number>;

function emptyStatusCounts(): StatusCounts {
  return {
    NEW: 0,
    ASSIGNED: 0,
    RINGING: 0,
    BUSY: 0,
    CALL_BACK: 0,
    FOLLOW_UP: 0,
    SWITCHED_OFF: 0,
    DND: 0,
    NOT_REACHABLE: 0,
    INTERESTED: 0,
    NOT_INTERESTED: 0,
    CONVERTED: 0,
  };
}

function fillStatusCounts(rows: { workingStatus: LeadWorkingStatus; _count: { _all: number } }[]): StatusCounts {
  const counts = emptyStatusCounts();
  for (const row of rows) {
    counts[row.workingStatus] = row._count._all;
  }
  return counts;
}

class DashboardService {
  async getDashboard(user: AuthUser) {
    switch (user.role) {
      case Role.SALESPERSON:
        return this.salespersonDashboard(user.id);
      case Role.MANAGER:
        return this.managerDashboard(user.id);
      case Role.ADMIN:
        return this.adminDashboard();
    }
  }

  private async salespersonDashboard(userId: string) {
    const [statusRows, totalLeads, recentLeads] = await Promise.all([
      prisma.lead.groupBy({
        by: ["workingStatus"],
        where: { ownerId: userId },
        _count: { _all: true },
      }),
      prisma.lead.count({ where: { ownerId: userId } }),
      prisma.lead.findMany({
        where: { ownerId: userId },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: {
          id: true,
          leadNumber: true,
          firstName: true,
          lastName: true,
          workingStatus: true,
          priority: true,
          updatedAt: true,
        },
      }),
    ]);

    // A salesperson never sees ASSIGNED: those leads count as NEW.
    const statusCounts = fillStatusCounts(statusRows);
    statusCounts.NEW += statusCounts.ASSIGNED;
    statusCounts.ASSIGNED = 0;

    return {
      role: Role.SALESPERSON,
      totalLeads,
      statusCounts,
      recentLeads: recentLeads.map((lead) => ({ ...lead, workingStatus: statusForRole(lead.workingStatus, Role.SALESPERSON) })),
    };
  }

  private async managerDashboard(userId: string) {
    const groups = await prisma.group.findMany({
      where: { managerId: userId },
      include: {
        members: {
          where: { isActive: true },
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    });

    const groupIds = groups.map((g) => g.id);
    const memberIds = [...new Set(groups.flatMap((g) => g.members.map((m) => m.userId)))];

    const [statusRows, totalLeads, perSalespersonRows] = await Promise.all([
      prisma.lead.groupBy({
        by: ["workingStatus"],
        where: { OR: [{ groupId: { in: groupIds } }, { ownerId: { in: memberIds } }] },
        _count: { _all: true },
      }),
      prisma.lead.count({
        where: { OR: [{ groupId: { in: groupIds } }, { ownerId: { in: memberIds } }] },
      }),
      prisma.lead.groupBy({
        by: ["ownerId", "workingStatus"],
        where: { ownerId: { in: memberIds } },
        _count: { _all: true },
      }),
    ]);

    // A salesperson can be an active member of more than one of this manager's
    // groups, which would otherwise duplicate them in `team` (and break React's
    // key uniqueness on the dashboard) — dedupe by id, keeping the first hit.
    const teamMembers = Array.from(
      new Map(groups.flatMap((g) => g.members.map((m) => m.user)).map((user) => [user.id, user])).values(),
    );

    const team = teamMembers.map((member) => {
      const rows = perSalespersonRows.filter((r) => r.ownerId === member.id);
      const counts = fillStatusCounts(
        rows.map((r) => ({ workingStatus: r.workingStatus, _count: r._count })),
      );
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      return { ...member, totalLeads: total, statusCounts: counts };
    });

    return {
      role: Role.MANAGER,
      groups: groups.map((g) => ({ id: g.id, name: g.name, status: g.status })),
      totalLeads,
      statusCounts: fillStatusCounts(statusRows),
      team,
    };
  }

  private async adminDashboard() {
    const [statusRows, totalLeads, usersByRole, totalGroups] = await Promise.all([
      prisma.lead.groupBy({ by: ["workingStatus"], _count: { _all: true } }),
      prisma.lead.count(),
      prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
      prisma.group.count(),
    ]);

    return {
      role: Role.ADMIN,
      totalLeads,
      totalGroups,
      statusCounts: fillStatusCounts(statusRows),
      usersByRole: usersByRole.map((r) => ({ role: r.role, count: r._count._all })),
    };
  }
}

export default DashboardService;