import { LeadWorkingStatus, Role } from "../../generated/prisma/enums.js";

// ASSIGNED only tells a manager or admin that a lead has been handed out. A salesperson sees it as NEW
// until they log a call result, so it is never sent to them.
export function statusForRole(status: LeadWorkingStatus, role: Role): LeadWorkingStatus {
  return role === Role.SALESPERSON && status === LeadWorkingStatus.ASSIGNED ? LeadWorkingStatus.NEW : status;
}
