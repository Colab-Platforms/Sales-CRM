import type { LeadWorkingStatus } from "./dashboard.types";
import type { Call } from "./calling.types";
import type { LeadFollowUp } from "./tasks.types";

export type LeadPriority = "LOW" | "MEDIUM" | "HIGH";
export type AssignmentFilter = "UNASSIGNED" | "ASSIGNED_TO_MANAGER" | "ASSIGNED_TO_SALESPERSON";

export interface LeadSource {
  id: string;
  name: string;
}

export interface LeadUserRef {
  id: string;
  name: string;
  username: string;
}

export interface LeadGroupRef {
  id: string;
  name: string;
}

export interface LeadImportBatchRef {
  fileName: string;
  uploadedBy: { id: string; name: string; role: string };
}

export type AiAgentIntent = "ALREADY_ORDERED" | "INTERESTED";

export interface AiAgentTag {
  lastActivityAt: string;
  lastResult: string | null;
  lastTitle: string | null;
  lastIntent: AiAgentIntent | null;
  lastMethod: "COD" | "PREPAID" | null;
  /** true when the agent has reported this customer as interested ("Interested - AI Agent"). */
  interested: boolean;
}

/** Customer classification from real order history. Independent of campaign segments. */
export type CustomerClass = "REPEAT" | "LOYAL" | "VIP";

/** A campaign segment tag on a lead (admin-defined group, e.g. "Diwali Mega Sale"). */
export interface SegmentTag {
  id: string;
  name: string;
  color: string;
  isActive: boolean;
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
  calls: Call[];
  /** The lead's pending call back / follow up reminder - empty when none is scheduled. */
  tasks: LeadFollowUp[];
  /** The "AI Agent" tag: the latest request the AI calling agency made about this lead; null when it never did. Separate from owner / assignedManager (human telecallers). */
  aiAgent: AiAgentTag | null;
  /** Campaign segments the lead belongs to (any number). Stay on the lead whoever it is assigned to. */
  segments: SegmentTag[];
  /** Repeat / Loyal / VIP from the customer's real order count; null = not classified. */
  customerClass: CustomerClass | null;
  orderCount?: number | null;
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
  bucket?: "TODAY";
  search?: string;
  /** Column filters of the Leads table. managerId / salespersonId also accept "NONE" (unassigned). Dates are inclusive YYYY-MM-DD (India time). */
  name?: string;
  contact?: string;
  priority?: LeadPriority;
  createdFrom?: string;
  createdTo?: string;
  /** Campaign segment and customer classification: two independent filters. */
  segmentId?: string;
  customerClass?: CustomerClass;
  /** ONLY: leads the AI calling agency made a request about. EXCLUDE: leads it did not. */
  aiAgent?: "ONLY" | "EXCLUDE";
  /** Leads with an AI Agent request of this intent (implies AI Agent leads). */
  aiAgentIntent?: AiAgentIntent;
}

export type BucketKind = "LEAD" | "ABANDONED";

export interface BucketSummaryRow {
  salespersonId: string;
  name: string;
  total: number;
  done: number;
  remaining: number;
  isEmpty: boolean;
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
  /** ISO time to remind the salesperson; required when switching to CALL_BACK or FOLLOW_UP. */
  followUpAt?: string;
  /** What the customer said; attached to the call back / follow up reminder. */
  note?: string;
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

/** "Every lead matching this filter" (e.g. a whole segment) instead of an explicit id list. */
export type LeadIdFilter = Pick<LeadListParams, "segmentId" | "customerClass" | "assignment" | "sourceId" | "workingStatus" | "search" | "managerId" | "salespersonId" | "name" | "contact" | "priority" | "createdFrom" | "createdTo">;

export interface BulkDeletePreview {
  /** Leads matching the selection. */
  matched: number;
  /** Of those, how many will be deleted (the rest have orders and are kept). */
  deletable: number;
  skippedWithOrders: number;
}

export interface BulkDeleteResult {
  deleted: number;
  remaining: number;
  skippedWithOrders: number;
  done: boolean;
}

export type BulkDeletePayload = { leadIds?: string[]; filter?: LeadIdFilter; all?: true; confirmText?: string; expectedCount: number; confirm: true; continuation?: boolean };

export interface BulkAssignManagerPayload {
  leadIds?: string[];
  filter?: LeadIdFilter;
  method: "MANUAL" | "ROUND_ROBIN";
  managerId?: string;
  managerIds?: string[];
}

export interface BulkAssignSalespersonPayload {
  leadIds?: string[];
  filter?: LeadIdFilter;
  method: "MANUAL" | "ROUND_ROBIN";
  salespersonId?: string;
  salespersonIds?: string[];
}

export interface BulkUpdateStatusPayload {
  leadIds: string[];
  workingStatus: LeadWorkingStatus;
  /** Required when workingStatus is CALL_BACK or FOLLOW_UP; applied to every selected lead. */
  followUpAt?: string;
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

// ----------------------------------------------------------------------------------------------- file import v2 (Excel / CSV)

export type ImportField =
  | "fullName" | "firstName" | "lastName" | "mobile" | "email" | "orderCount" | "totalOrdersValue" | "city" | "state" | "address"
  | "pincode" | "product" | "lastOrderDate" | "paymentInfo" | "requirement" | "location" | "sourceName" | "extra";

export interface ImportDetectedColumn {
  header: string;
  field: ImportField;
  confidence: "exact" | "likely" | "none";
  conflictWith?: string;
  samples: string[];
}

export interface FileImportPreview {
  totalRows: number;
  eligibleRows: number;
  invalidRows: number;
  newLeads: number;
  missingPhone: number;
  missingOrderCount: number;
  invalidOrderCount: number;
  classification: { repeat: number; loyal: number; vip: number; unclassified: number };
  problems: { row: number; reason: string }[];
}

export interface FileImportAnalysis {
  batchId: string;
  fileName: string;
  totalRows: number;
  segmentId: string | null;
  rememberedMapping: boolean;
  columns: ImportDetectedColumn[];
  mapping: Record<string, ImportField>;
  needsReview: { header: string; conflictWith?: string }[];
  unrecognized: string[];
  preview: FileImportPreview;
}

export interface FileImportMappingResult {
  batchId: string;
  mapping: Record<string, ImportField>;
  preview: FileImportPreview;
}

export interface FileImportProgress {
  batchId: string;
  fileName: string;
  status: "DRAFT" | "PROCESSING" | "COMMITTED" | "FAILED";
  segmentId: string | null;
  totalRows: number;
  processedRows: number;
  pendingRows: number;
  percent: number;
  created: number;
  updated: number;
  segmentMembershipsAdded: number;
  duplicates: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  canResume: boolean;
}
