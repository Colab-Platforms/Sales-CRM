import type { LeadWorkingStatus } from "./dashboard.types";

export type LeadPriority = "LOW" | "MEDIUM" | "HIGH";
export type AssignmentFilter = "UNASSIGNED" | "ASSIGNED_TO_MANAGER" | "ASSIGNED_TO_SALESPERSON";

export interface LeadSource {
  id: string;
  name: string;
}

export interface LeadUserRef {
  id: string;
  name: string;
  email: string;
}

export interface LeadGroupRef {
  id: string;
  name: string;
}

export interface LeadImportBatchRef {
  fileName: string;
  uploadedBy: { id: string; name: string; role: string };
}

export interface Lead {
  id: string;
  leadNumber: string;
  firstName: string;
  lastName: string | null;
  mobile: string | null;
  email: string | null;
  requirement: string | null;
  location: string | null;
  workingStatus: LeadWorkingStatus;
  priority: LeadPriority;
  createdAt: string;
  updatedAt: string;
  source: LeadSource | null;
  owner: LeadUserRef | null;
  assignedManager: LeadUserRef | null;
  group: LeadGroupRef | null;
  importBatch: LeadImportBatchRef | null;
}

export interface LeadListPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface LeadListResult {
  data: Lead[];
  pagination: LeadListPagination;
}

export interface LeadListParams {
  page?: number;
  limit?: number;
  sourceId?: string;
  workingStatus?: LeadWorkingStatus;
  assignment?: AssignmentFilter;
  managerId?: string;
  salespersonId?: string;
  search?: string;
}

export interface CreateLeadPayload {
  firstName: string;
  lastName?: string;
  mobile?: string;
  email?: string;
  requirement?: string;
  location?: string;
  sourceId?: string;
  priority?: LeadPriority;
}

export interface UpdateLeadPayload {
  firstName?: string;
  lastName?: string;
  mobile?: string;
  email?: string;
  requirement?: string;
  location?: string;
  workingStatus?: LeadWorkingStatus;
  priority?: LeadPriority;
}

export interface LeadAssignmentRecord {
  id: string;
  assignmentType: "ROUND_ROBIN" | "MANUAL" | "REASSIGNMENT";
  assignedAt: string;
  unassignedAt: string | null;
  isCurrent: boolean;
  user: { id: string; name: string; role: string };
  assignedBy: { id: string; name: string; role: string } | null;
  group: LeadGroupRef | null;
}

export interface BulkAssignManagerPayload {
  leadIds: string[];
  method: "MANUAL" | "ROUND_ROBIN";
  managerId?: string;
  managerIds?: string[];
}

export interface BulkAssignSalespersonPayload {
  leadIds: string[];
  method: "MANUAL" | "ROUND_ROBIN";
  salespersonId?: string;
  salespersonIds?: string[];
}

export interface ImportPreviewResult {
  batchId: string;
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  invalidRows: number;
  sampleErrors: { row: number; reason: string }[];
}

export interface ImportBatchSummary {
  id: string;
  fileName: string;
  status: "DRAFT" | "COMMITTED" | "FAILED";
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  invalidRows: number;
  createdAt: string;
  committedAt: string | null;
}
