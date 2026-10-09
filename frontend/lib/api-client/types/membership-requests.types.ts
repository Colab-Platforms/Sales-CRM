export type MembershipRequestStatus = "PENDING" | "APPROVED" | "REJECTED";
export type MembershipRequestStatusFilter = MembershipRequestStatus | "ALL";

export interface MembershipRequestActor {
  id: string;
  name: string;
  role: string;
}

export interface MembershipRequestView {
  id: string;
  group: { id: string; name: string; managerId: string; status: string };
  salesperson: { id: string; name: string; username: string };
  requestedBy: MembershipRequestActor;
  requestNote: string | null;
  status: MembershipRequestStatus;
  decidedBy: MembershipRequestActor | null;
  decisionAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface CreateMembershipRequestInput {
  groupId: string;
  salespersonId: string;
  note?: string;
}
