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
//   HR          -> none (HR only works within Team management, never with leads)
//   HR          -> none
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
    case Role.HR:
    case Role.RECRUITER:
      // Matches no row: an id can never be in an empty list.
      // HR manages staff accounts and recruiters work job applications; neither sees CRM leads or orders.
      return { id: { in: [] } };
  }
}

export async function getLeadScope(user: AuthUser, db: DbClient = prisma): Promise<Prisma.LeadWhereInput> {
  const team = user.role === Role.MANAGER ? await getManagerTeam(user.id, db) : undefined;
  return buildLeadScope(user.role, user.id, team);
}

// The scope for working an ORDER from a WhatsApp chat (create it, load its payment options and last address, create its payment link, and the Shopify link step of that same creation). It is the user's normal lead scope PLUS any lead
// whose WhatsApp conversation is assigned to this user - the same rule the conversation service already applies (a conversation can be assigned to someone handling WhatsApp for a
// customer they do not own outright). It never changes who owns a lead, and it is NOT used for editing / deleting a customer, cancelling, refunding or any other action. HR gets nothing.
export function buildOrderFlowScope(scope: Prisma.LeadWhereInput, role: Role, userId: string): Prisma.LeadWhereInput {
  if (Object.keys(scope).length === 0) return scope; // unrestricted (ADMIN)
  if (role === Role.HR) return scope;
  return { OR: [scope, { whatsAppConversation: { is: { assignedToId: userId } } }] };
}

export async function getOrderFlowScope(user: AuthUser, db: DbClient = prisma): Promise<Prisma.LeadWhereInput> {
  return buildOrderFlowScope(await getLeadScope(user, db), user.role, user.id);
}
