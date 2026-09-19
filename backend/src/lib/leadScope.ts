import { prisma } from "@/lib/prisma.js";
import { Role } from "../../generated/prisma/enums.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { AuthUser } from "@/middlewares/auth.js";

export type DbClient = Prisma.TransactionClient;

export interface ManagerTeam {
  groupIds: string[];
  members: { id: string; name: string }[];
}

// Same team definition the dashboard uses: groups the manager runs, plus the
// active members of those groups.
export async function getManagerTeam(managerId: string, db: DbClient = prisma): Promise<ManagerTeam> {
  const groups = await db.group.findMany({
    where: { managerId },
    include: {
      members: {
        where: { isActive: true },
        include: { user: { select: { id: true, name: true } } },
      },
    },
  });

  const members = new Map<string, { id: string; name: string }>();
  for (const group of groups) {
    for (const member of group.members) {
      members.set(member.user.id, member.user);
    }
  }

  return { groupIds: groups.map((g) => g.id), members: [...members.values()] };
}

// Which leads a user may see. Orders (and later customer data) inherit access
// from their lead:
//   ADMIN       -> every lead
//   MANAGER     -> leads in their groups, or owned by their active team members
//   SALESPERSON -> leads they own
export function buildLeadScope(role: Role, userId: string, team?: ManagerTeam): Prisma.LeadWhereInput {
  switch (role) {
    case Role.ADMIN:
      return {};
    case Role.MANAGER:
      return {
        OR: [
          { groupId: { in: team?.groupIds ?? [] } },
          { ownerId: { in: team?.members.map((m) => m.id) ?? [] } },
        ],
      };
    case Role.SALESPERSON:
      return { ownerId: userId };
  }
}

export async function getLeadScope(user: AuthUser, db: DbClient = prisma): Promise<Prisma.LeadWhereInput> {
  const team = user.role === Role.MANAGER ? await getManagerTeam(user.id, db) : undefined;
  return buildLeadScope(user.role, user.id, team);
}
