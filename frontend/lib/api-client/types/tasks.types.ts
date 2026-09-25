export type FollowUpTaskType = "CALLBACK" | "FOLLOW_UP";

export interface FollowUpTask {
  id: string;
  type: FollowUpTaskType;
  title: string;
  description: string | null;
  scheduledAt: string;
  lead: {
    id: string;
    leadNumber: string;
    firstName: string;
    lastName: string | null;
    mobile: string | null;
  };
}

/** A lead's pending call back / follow up reminder, as sent with the lead itself. */
export interface LeadFollowUp {
  id: string;
  type: FollowUpTaskType;
  scheduledAt: string;
}
