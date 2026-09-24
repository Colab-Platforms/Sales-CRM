export interface GroupMemberUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
}

export interface GroupMember {
  id: string;
  userId: string;
  isActive: boolean;
  joinedAt: string;
  user: GroupMemberUser;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  managerId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  members: GroupMember[];
}

export interface CreateGroupPayload {
  name: string;
  description?: string;
}

export interface AddSalespersonPayload {
  name: string;
  email: string;
  password: string;
  phone?: string;
}

export interface CreateSalespersonPayload extends AddSalespersonPayload {
  groupId: string;
}

export interface SalespersonUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: "SALESPERSON";
  status: string;
}

export interface AddExistingMemberPayload {
  userId: string;
}

export interface UpdateGroupPayload {
  name?: string;
  description?: string;
  status?: "ACTIVE" | "INACTIVE";
}

export interface UpdateSalespersonPayload {
  name?: string;
  phone?: string;
  status?: "ACTIVE" | "INACTIVE";
}

export interface SalespersonWithGroup extends SalespersonUser {
  currentGroup: { id: string; name: string } | null;
}

export interface MySalesperson {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  groupId: string | null;
  groupName: string | null;
}
