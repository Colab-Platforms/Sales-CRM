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

export interface MySalesperson {
  id: string;
  name: string;
  username: string;
  phone: string | null;
  status: string;
  groupId: string | null;
  groupName: string | null;
}
