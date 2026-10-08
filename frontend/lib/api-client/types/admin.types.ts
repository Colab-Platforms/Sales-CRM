export interface ManagerUser {
  id: string;
  name: string;
  username: string;
  phone: string | null;
  role: "MANAGER";
  status: string;
}

export interface CreateManagerPayload {
  name: string;
  username: string;
  password: string;
  phone: string;
}

export interface UpdateManagerPayload {
  name?: string;
  phone?: string;
  status?: "ACTIVE" | "INACTIVE";
}

export interface SalespersonUser {
  id: string;
  name: string;
  username: string;
  phone: string | null;
  role: "SALESPERSON";
  status: string;
  reportingManager: { id: string; name: string; username: string } | null;
}

export interface CreateSalespersonPayload {
  name: string;
  username: string;
  password: string;
  phone: string;
  reportingManagerId: string;
}

export interface UpdateSalespersonPayload {
  name?: string;
  phone?: string;
  status?: "ACTIVE" | "INACTIVE";
  reportingManagerId?: string;
}

export interface ResetPasswordPayload {
  password: string;
}

export interface HrUser {
  id: string;
  name: string;
  username: string;
  phone: string | null;
  role: "HR";
  status: string;
}

export interface CreateHrPayload {
  name: string;
  username: string;
  password: string;
  phone: string;
}

export interface GroupMemberUser {
  id: string;
  name: string;
  username: string;
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

export interface GroupManager {
  id: string;
  name: string;
  username: string;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  managerId: string;
  manager: GroupManager;
  status: string;
  createdAt: string;
  updatedAt: string;
  members: GroupMember[];
}

export interface CreateGroupPayload {
  name: string;
  description?: string;
  managerId: string;
}

export interface UpdateGroupPayload {
  name?: string;
  description?: string;
  status?: "ACTIVE" | "INACTIVE";
  managerId?: string;
}

export interface AddSalespersonPayload {
  name: string;
  username: string;
  password: string;
  phone: string;
}

export interface AddExistingMemberPayload {
  userId: string;
}
