export interface CreateMembershipRequestBody {
  groupId: string;
  salespersonId: string;
  note?: string;
}

export interface DecisionBody {
  note?: string;
}

export type ListStatusFilter = "PENDING" | "APPROVED" | "REJECTED" | "ALL";

export interface ListMembershipRequestsQuery {
  status: ListStatusFilter;
}
