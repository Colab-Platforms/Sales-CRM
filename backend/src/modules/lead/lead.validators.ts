import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type {
  CreateLeadBody,
  UpdateLeadBody,
  ListLeadsQuery,
  BulkAssignManagerBody,
  BulkAssignSalespersonBody,
  ImportPreviewBody,
} from "./lead.types.js";

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
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

const listLeadsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sourceId: z.string().guid().optional(),
  workingStatus: workingStatusEnum.optional(),
  lifecycleStage: z.enum(["LEAD", "CUSTOMER"]).optional(),
  assignment: assignmentEnum.optional(),
  managerId: z.string().guid().optional(),
  salespersonId: z.string().guid().optional(),
  search: z.string().max(255).optional(),
});

const bulkAssignManagerSchema = z
  .object({
    leadIds: z.array(z.string().guid()).min(1, "No leads selected"),
    method: z.enum(["MANUAL", "ROUND_ROBIN"]),
    managerId: z.string().guid().optional(),
    managerIds: z.array(z.string().guid()).optional(),
  })
  .refine((data) => (data.method === "MANUAL" ? Boolean(data.managerId) : Boolean(data.managerIds?.length)), {
    message: "managerId is required for manual assignment, managerIds is required for round robin",
  });

const bulkAssignSalespersonSchema = z
  .object({
    leadIds: z.array(z.string().guid()).min(1, "No leads selected"),
    method: z.enum(["MANUAL", "ROUND_ROBIN"]),
    salespersonId: z.string().guid().optional(),
    salespersonIds: z.array(z.string().guid()).optional(),
  })
  .refine((data) => (data.method === "MANUAL" ? Boolean(data.salespersonId) : Boolean(data.salespersonIds?.length)), {
    message: "salespersonId is required for manual assignment, salespersonIds is required for round robin",
  });

const importPreviewSchema = z.object({
  columnMapping: z.record(z.string(), z.string()),
});

export const validateCreateLeadSchema = (body: unknown) => validateSchema<CreateLeadBody>(createLeadSchema, body);

export const validateUpdateLeadSchema = (body: unknown) => validateSchema<UpdateLeadBody>(updateLeadSchema, body);

export const validateListLeadsQuerySchema = (query: unknown) =>
  validateSchema<ListLeadsQuery>(listLeadsQuerySchema, query);

export const validateBulkAssignManagerSchema = (body: unknown) =>
  validateSchema<BulkAssignManagerBody>(bulkAssignManagerSchema, body);

export const validateBulkAssignSalespersonSchema = (body: unknown) =>
  validateSchema<BulkAssignSalespersonBody>(bulkAssignSalespersonSchema, body);

export const validateImportPreviewSchema = (body: unknown) =>
  validateSchema<ImportPreviewBody>(importPreviewSchema, body);
