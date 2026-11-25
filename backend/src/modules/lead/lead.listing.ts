import { LifecycleStage, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { AuthUser } from "@/middlewares/auth.js";

// WHICH LEADS THE LEAD SECTION LISTS. One definition, used by the Leads list (lead.service.ts) and by the Reports' segment lead report, so the two cannot show different totals for the same segment.
//  - whose:        an Admin sees every lead, a manager the leads assigned to them, a salesperson the leads they own;
//  - which:        records at the LEAD stage (a converted lead becomes a CUSTOMER and leaves the list) ...
//  - never:        ... and no abandoned-cart records: those live in the Abandoned Leads queue, even once worked or recovered.

export function leadListScope(user: Pick<AuthUser, "id" | "role">): Prisma.LeadWhereInput {
  if (user.role === Role.MANAGER) return { assignedManagerId: user.id };
  if (user.role === Role.SALESPERSON) return { ownerId: user.id };
  return {};
}

export function leadListEligibility(lifecycleStage: LifecycleStage = LifecycleStage.LEAD): { lifecycleStage: LifecycleStage; abandonments: Prisma.AbandonmentListRelationFilter } {
  return { lifecycleStage, abandonments: { none: {} } };
}

/** The exact opposite of the default list: records the Lead section leaves out (converted to customer, or from an abandoned cart). */
export const NOT_IN_LEAD_LIST: Prisma.LeadWhereInput = { OR: [{ lifecycleStage: { not: LifecycleStage.LEAD } }, { abandonments: { some: {} } }] };
