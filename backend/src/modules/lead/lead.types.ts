export interface CreateLeadBody {
  firstName: string;
  lastName?: string;
  mobile?: string;
  email?: string;
  requirement?: string;
  location?: string;
  sourceId?: string;
  interestedProductId?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH";
}

export interface UpdateLeadBody {
  firstName?: string;
  lastName?: string;
  mobile?: string;
  email?: string;
  requirement?: string;
  location?: string;
  sourceId?: string;
  interestedProductId?: string;
  workingStatus?: "NEW" | "ASSIGNED" | "WORKING" | "INTERESTED" | "EXPIRED" | "CONVERTED" | "CLOSED";
  priority?: "LOW" | "MEDIUM" | "HIGH";
}

export type AssignmentFilter = "UNASSIGNED" | "ASSIGNED_TO_MANAGER" | "ASSIGNED_TO_SALESPERSON";

export interface ListLeadsQuery {
  page: number;
  limit: number;
  sourceId?: string;
  workingStatus?: string;
  assignment?: AssignmentFilter;
  managerId?: string;
  salespersonId?: string;
  search?: string;
}

export interface BulkAssignManagerBody {
  leadIds: string[];
  method: "MANUAL" | "ROUND_ROBIN";
  managerId?: string;
  managerIds?: string[];
}

export interface BulkAssignSalespersonBody {
  leadIds: string[];
  method: "MANUAL" | "ROUND_ROBIN";
  salespersonId?: string;
  salespersonIds?: string[];
}

export interface ImportPreviewBody {
  columnMapping: Record<string, string>;
}
