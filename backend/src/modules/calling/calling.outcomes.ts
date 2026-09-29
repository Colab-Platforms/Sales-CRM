import type { LeadWorkingStatus } from "../../../generated/prisma/enums.js";

// Which lead status a call outcome's code sets. Kept as its own small map (rather than deriving from
// CallOutcome.category) so a lead status can be picked precisely per outcome, not just per category -
// e.g. BUSY and SWITCHED_OFF share the NOT_CONNECTED category but are different lead statuses.
export const OUTCOME_LEAD_STATUS: Record<string, LeadWorkingStatus> = {
  RINGING_NO_ANSWER: "RINGING",
  BUSY: "BUSY",
  SWITCHED_OFF: "SWITCHED_OFF",
  NOT_REACHABLE: "NOT_REACHABLE",
  DND: "DND",
  CALL_BACK_REQUESTED: "CALL_BACK",
  FOLLOW_UP_NEEDED: "FOLLOW_UP",
  INTERESTED: "INTERESTED",
  NOT_INTERESTED: "NOT_INTERESTED",
};
