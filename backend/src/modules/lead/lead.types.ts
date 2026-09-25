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
  workingStatus?: "NEW" | "ASSIGNED" | "RINGING" | "BUSY" | "CALL_BACK" | "FOLLOW_UP" | "SWITCHED_OFF" | "DND" | "NOT_REACHABLE" | "INTERESTED" | "NOT_INTERESTED" | "CONVERTED";
  priority?: "LOW" | "MEDIUM" | "HIGH";
  // Required when workingStatus changes to CALL_BACK or FOLLOW_UP: when to remind the salesperson.
  followUpAt?: string;
}

export type AssignmentFilter = "UNASSIGNED" | "ASSIGNED_TO_MANAGER" | "ASSIGNED_TO_SALESPERSON";

export interface ListLeadsQuery {
  page: number;
  limit: number;
  sourceId?: string;
  workingStatus?: string;
  lifecycleStage?: "LEAD" | "CUSTOMER";
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
