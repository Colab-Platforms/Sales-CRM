export type Role = "ADMIN" | "MANAGER" | "SALESPERSON";

export interface CurrentUser {
  id: string;
  name: string;
  username: string;
  role: Role;
  status: string;
}

export interface LoginPayload {
  username: string;
  password: string;
}

export interface LoginResult {
  user: CurrentUser;
  accessToken: string;
}

export interface ProfileReportingManager {
  id: string;
  name: string;
  username: string;
  phone: string | null;
}

export interface ProfileTeam {
  id: string;
  name: string;
  status: string;
  joinedAt: string;
}

export interface ProfileGroup {
  id: string;
  name: string;
  status: string;
  memberCount: number;
}

interface ProfileBase {
  id: string;
  name: string;
  username: string;
  email: string | null;
  phone: string | null;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SalespersonProfile extends ProfileBase {
  role: "SALESPERSON";
  reportingManager: ProfileReportingManager | null;
  teams: ProfileTeam[];
  stats: { totalLeads: number };
}

export interface ManagerProfile extends ProfileBase {
  role: "MANAGER";
  groups: ProfileGroup[];
  teamMemberCount: number;
  stats: { totalLeads: number };
}

export interface AdminProfile extends ProfileBase {
  role: "ADMIN";
  orgOverview: {
    totalManagers: number;
    totalSalespersons: number;
    totalGroups: number;
    totalLeads: number;
  };
}

export type UserProfile = SalespersonProfile | ManagerProfile | AdminProfile;
