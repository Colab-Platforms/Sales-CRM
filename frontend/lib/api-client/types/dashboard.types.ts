export type LeadWorkingStatus =
  | "NEW"
  | "ASSIGNED"
  | "WORKING"
  | "INTERESTED"
  | "EXPIRED"
  | "CONVERTED"
  | "CLOSED";

export type StatusCounts = Record<LeadWorkingStatus, number>;

export interface RecentLead {
  id: string;
  leadNumber: string;
  firstName: string;
  lastName: string | null;
  workingStatus: LeadWorkingStatus;
  priority: "LOW" | "MEDIUM" | "HIGH";
  updatedAt: string;
}

export interface SalespersonDashboard {
  role: "SALESPERSON";
  totalLeads: number;
  statusCounts: StatusCounts;
  recentLeads: RecentLead[];
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  totalLeads: number;
  statusCounts: StatusCounts;
}

export interface ManagerDashboard {
  role: "MANAGER";
  groups: { id: string; name: string; status: string }[];
  totalLeads: number;
  statusCounts: StatusCounts;
  team: TeamMember[];
}

export interface AdminDashboard {
  role: "ADMIN";
  totalLeads: number;
  totalGroups: number;
  statusCounts: StatusCounts;
  usersByRole: { role: string; count: number }[];
}

export type DashboardData = SalespersonDashboard | ManagerDashboard | AdminDashboard;
