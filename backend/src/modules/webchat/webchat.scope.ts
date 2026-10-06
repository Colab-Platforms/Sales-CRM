import type { Prisma } from "../../../generated/prisma/client.js";
import { Role } from "../../../generated/prisma/enums.js";
import { getManagerTeam, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";

/**
 * Which Website Chat conversations a user may see or act on. Built on the same team/ownership
 * primitives as lib/leadScope.ts (getManagerTeam, Lead.ownerId, Lead.groupId) - no second
 * authorisation system.
 *
 *   ADMIN       -> every conversation
 *   MANAGER     -> conversations assigned to them or their team, OR unassigned (the open queue),
 *                  OR linked to a Lead in their team's scope
 *   SALESPERSON -> conversations assigned to them, OR unassigned (the open queue),
 *                  OR linked to a Lead they own
 *
 * The unassigned clause is deliberate: the Live Queue exists so an unclaimed chat can be seen and
 * picked up. Everything else stays restricted, exactly like Leads.
 */
export async function buildWebChatScope(user: AuthUser, db: DbClient): Promise<Prisma.WebChatConversationWhereInput> {
  if (user.role === Role.ADMIN) return {};

  if (user.role === Role.MANAGER) {
    const team = await getManagerTeam(user.id, db);
    const memberIds = team.members.map((m) => m.id);
    return {
      OR: [
        { assignedToId: { in: [user.id, ...memberIds] } },
        { assignedToId: null },
        { lead: { OR: [{ groupId: { in: team.groupIds } }, { ownerId: { in: memberIds } }] } },
      ],
    };
  }

  return {
    OR: [{ assignedToId: user.id }, { assignedToId: null }, { lead: { ownerId: user.id } }],
  };
}

/** Who a given user may assign a conversation TO. Mirrors the lead assignment rules: a salesperson
 * can only claim a chat for themselves; a manager can assign to self or their own team; an admin
 * can assign to any active salesperson or manager. */
export async function canAssignConversationTo(user: AuthUser, targetUserId: string, db: DbClient): Promise<boolean> {
  if (user.role === Role.SALESPERSON) return targetUserId === user.id;

  if (user.role === Role.MANAGER) {
    if (targetUserId === user.id) return true;
    const team = await getManagerTeam(user.id, db);
    return team.members.some((m) => m.id === targetUserId);
  }

  return true;
}
