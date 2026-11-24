import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type {
  CreateLeadBody,
  UpdateLeadBody,
  ListLeadsQuery,
  BulkAssignManagerBody,
  BulkAssignSalespersonBody,
  BulkUpdateStatusBody,
  ImportPreviewBody,
  LeadIdFilter,
} from "./lead.types.js";

export const DELETE_ALL_PHRASE = "DELETE ALL";

// .guid() (not .uuid()) throughout this file — .uuid() enforces RFC 9562
// version/variant bits, but Postgres's uuid column (and thus ids already in
// the database, e.g. seeded rows) accepts any 32-hex-digit UUID regardless.
const priorityEnum = z.enum(["LOW", "MEDIUM", "HIGH"]);
const workingStatusEnum = z.enum(["NEW", "ASSIGNED", "RINGING", "BUSY", "CALL_BACK", "FOLLOW_UP", "SWITCHED_OFF", "DND", "NOT_REACHABLE", "INTERESTED", "NOT_INTERESTED", "CONVERTED"]);
const assignmentEnum = z.enum(["UNASSIGNED", "ASSIGNED_TO_MANAGER", "ASSIGNED_TO_SALESPERSON"]);

const createLeadSchema = z
  .object({
    firstName: z.string().min(1).max(100),
    lastName: z.string().max(100).optional(),
    mobile: z.string().max(20).optional(),
    email: z.string().email().max(255).optional(),
    requirement: z.string().optional(),
    location: z.string().max(255).optional(),
    sourceId: z.string().guid().optional(),
    interestedProductId: z.string().guid().optional(),
    priority: priorityEnum.optional(),
  })
  .refine((data) => Boolean(data.mobile) || Boolean(data.email), {
    message: "Either mobile or email is required",
  });

const updateLeadSchema = z
  .object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().max(100).optional(),
    mobile: z.string().max(20).optional(),
    email: z.string().email().max(255).optional(),
    requirement: z.string().optional(),
    location: z.string().max(255).optional(),
    sourceId: z.string().guid().optional(),
    interestedProductId: z.string().guid().optional(),
    workingStatus: workingStatusEnum.optional(),
    priority: priorityEnum.optional(),
    followUpAt: z.string().datetime({ offset: true }).optional(),
    note: z.string().max(2000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

/** A person filter: a user id, or NONE for "unassigned". */
const personFilter = z.union([z.string().guid(), z.literal("NONE")]);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must look like 2026-11-24").refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "Not a real date");
const columnFilters = {
  name: z.string().trim().max(100).optional(),
  contact: z.string().trim().max(100).optional(),
  priority: priorityEnum.optional(),
  createdFrom: isoDay.optional(),
  createdTo: isoDay.optional(),
};

const listLeadsQuerySchema = z.object({
  ...columnFilters,
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sourceId: z.string().guid().optional(),
  segmentId: z.string().guid().optional(),
  customerClass: z.enum(["REPEAT", "LOYAL", "VIP"]).optional(),
  workingStatus: workingStatusEnum.optional(),
  lifecycleStage: z.enum(["LEAD", "CUSTOMER"]).optional(),
  assignment: assignmentEnum.optional(),
  managerId: personFilter.optional(),
  salespersonId: personFilter.optional(),
  bucket: z.enum(["TODAY"]).optional(),
  search: z.string().max(255).optional(),
  aiAgent: z.enum(["ONLY", "EXCLUDE"]).optional(),
  aiAgentIntent: z.enum(["ALREADY_ORDERED", "INTERESTED"]).optional(),
});

// "Every lead matching this filter" (e.g. a whole segment) instead of an explicit id list, which could not carry tens of thousands of ids.
const leadIdFilterSchema = z
  .object({
    ...columnFilters,
    segmentId: z.string().guid().optional(),
    customerClass: z.enum(["REPEAT", "LOYAL", "VIP"]).optional(),
    assignment: assignmentEnum.optional(),
    sourceId: z.string().guid().optional(),
    workingStatus: workingStatusEnum.optional(),
    search: z.string().max(255).optional(),
    managerId: personFilter.optional(),
    salespersonId: personFilter.optional(),
  })
  .strict()
  .refine((f) => Object.keys(f).length > 0, { message: "Apply at least one filter or search first: acting on every lead at once (an unfiltered selection) is not allowed" });

// Bulk delete: ids of the page being viewed (at most 100) OR a filter (every match across all pages), plus the exact count the user confirmed and an explicit confirm flag.
const bulkDeleteSchema = z
  .object({
    leadIds: z.array(z.string().guid()).min(1, "No leads selected").max(100, "At most 100 leads can be deleted by id; use a filter for more").optional(),
    filter: leadIdFilterSchema.optional(),
    // "Delete All Leads": every lead the Leads page lists, no filter. Needs the typed phrase on EVERY call, so it can never happen by accident or from a half-built request.
    all: z.literal(true).optional(),
    confirmText: z.string().max(40).optional(),
    expectedCount: z.number().int().min(0),
    confirm: z.literal(true, { error: "Deletion must be confirmed" }),
    continuation: z.boolean().optional(),
  })
  .strict()
  .refine((d) => [Boolean(d.leadIds?.length), Boolean(d.filter), d.all === true].filter(Boolean).length === 1, { message: "Send exactly one of leadIds, a filter, or all" })
  .refine((d) => d.all !== true || d.confirmText === DELETE_ALL_PHRASE, { message: `Type ${DELETE_ALL_PHRASE} to confirm deleting all leads` });
const bulkDeletePreviewSchema = z
  .object({ leadIds: z.array(z.string().guid()).min(1, "No leads selected").max(100, "At most 100 leads can be deleted by id; use a filter for more").optional(), filter: leadIdFilterSchema.optional(), all: z.literal(true).optional() })
  .strict()
  .refine((d) => [Boolean(d.leadIds?.length), Boolean(d.filter), d.all === true].filter(Boolean).length === 1, { message: "Send exactly one of leadIds, a filter, or all" });

const bulkAssignManagerSchema = z
  .object({
    leadIds: z.array(z.string().guid()).min(1, "No leads selected").optional(),
    filter: leadIdFilterSchema.optional(),
    method: z.enum(["MANUAL", "ROUND_ROBIN"]),
    managerId: z.string().guid().optional(),
    managerIds: z.array(z.string().guid()).optional(),
  })
  .refine((data) => Boolean(data.leadIds?.length) !== Boolean(data.filter), { message: "Send either leadIds or a filter" })
  .refine((data) => (data.method === "MANUAL" ? Boolean(data.managerId) : Boolean(data.managerIds?.length)), {
    message: "managerId is required for manual assignment, managerIds is required for round robin",
  });

const bulkAssignSalespersonSchema = z
  .object({
    leadIds: z.array(z.string().guid()).min(1, "No leads selected").optional(),
    filter: leadIdFilterSchema.optional(),
    method: z.enum(["MANUAL", "ROUND_ROBIN"]),
    salespersonId: z.string().guid().optional(),
    salespersonIds: z.array(z.string().guid()).optional(),
  })
  .refine((data) => Boolean(data.leadIds?.length) !== Boolean(data.filter), { message: "Send either leadIds or a filter" })
  .refine((data) => (data.method === "MANUAL" ? Boolean(data.salespersonId) : Boolean(data.salespersonIds?.length)), {
    message: "salespersonId is required for manual assignment, salespersonIds is required for round robin",
  });

const bulkUpdateStatusSchema = z.object({
  leadIds: z.array(z.string().guid()).min(1, "No leads selected"),
  workingStatus: workingStatusEnum,
  followUpAt: z.string().datetime({ offset: true }).optional(),
});

const importPreviewSchema = z.object({
  columnMapping: z.record(z.string(), z.string()),
});

export const validateBulkDeleteSchema = (body: unknown) => validateSchema<{ leadIds?: string[]; filter?: LeadIdFilter; all?: true; confirmText?: string; expectedCount: number; confirm: true; continuation?: boolean }>(bulkDeleteSchema, body);
export const validateBulkDeletePreviewSchema = (body: unknown) => validateSchema<{ leadIds?: string[]; filter?: LeadIdFilter; all?: true }>(bulkDeletePreviewSchema, body);

export const validateCreateLeadSchema = (body: unknown) => validateSchema<CreateLeadBody>(createLeadSchema, body);

export const validateUpdateLeadSchema = (body: unknown) => validateSchema<UpdateLeadBody>(updateLeadSchema, body);

export const validateListLeadsQuerySchema = (query: unknown) =>
  validateSchema<ListLeadsQuery>(listLeadsQuerySchema, query);

export const validateBulkAssignManagerSchema = (body: unknown) =>
  validateSchema<Omit<BulkAssignManagerBody, "leadIds"> & { leadIds?: string[] }>(bulkAssignManagerSchema, body);

export const validateBulkAssignSalespersonSchema = (body: unknown) =>
  validateSchema<Omit<BulkAssignSalespersonBody, "leadIds"> & { leadIds?: string[] }>(bulkAssignSalespersonSchema, body);

export const validateBulkUpdateStatusSchema = (body: unknown) =>
  validateSchema<BulkUpdateStatusBody>(bulkUpdateStatusSchema, body);

export const validateImportPreviewSchema = (body: unknown) =>
  validateSchema<ImportPreviewBody>(importPreviewSchema, body);
