import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { AbandonmentStatus, AbandonmentType, LeadWorkingStatus, RecoveryActionStatus, RecoveryActionType } from "../../../generated/prisma/enums.js";
import { parseItemKeys } from "./abandonment.items.js";
import type {
  BulkAssignManagerBody,
  BulkAssignSalespersonBody,
  CreateRecoveryActionBody,
  ListAbandonmentsQuery,
  UpdateAbandonmentStatusBody,
} from "./abandonment.types.js";

const idParams = z.object({ id: z.uuid({ error: "Invalid abandonment id" }) });
const leadIdParams = z.object({ leadId: z.uuid({ error: "Invalid lead id" }) });

// `?status=` from an unset filter is treated the same as absent - same convention as shiprocket.validators.ts.
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const assignmentEnum = z.enum(["UNASSIGNED", "ASSIGNED_TO_MANAGER", "ASSIGNED_TO_SALESPERSON"]);

const listQuerySchema = z
  .object({
    page: z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1),
    pageSize: z.coerce.number({ error: "pageSize must be a number" }).int().min(1, "pageSize must be between 1 and 100").max(100, "pageSize must be between 1 and 100").default(25),
    search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
    status: optional(z.enum(AbandonmentStatus, { error: "Invalid abandonment status" })),
    type: optional(z.enum(AbandonmentType, { error: "Invalid abandonment type" })),
    dateFrom: optional(z.iso.datetime({ offset: true, error: "dateFrom must be an ISO date-time" }).transform((v) => new Date(v))),
    dateTo: optional(z.iso.datetime({ offset: true, error: "dateTo must be an ISO date-time" }).transform((v) => new Date(v))),
    assignment: optional(assignmentEnum),
    managerId: optional(z.uuid()),
    salespersonId: optional(z.uuid()),
    workingStatus: optional(z.enum(LeadWorkingStatus, { error: "Invalid lead status" })),
    // Comma list of URL-encoded item keys ("s:SKU1,p:123%7CName"); decoded and validated by parseItemKeys.
    items: optional(z.string().max(4000, "items filter is too long").transform((v, ctx) => {
      const keys = parseItemKeys(v);
      if (keys === null) {
        ctx.addIssue({ code: "custom", message: "Invalid items filter" });
        return z.NEVER;
      }
      return keys;
    })),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, { error: "dateFrom must not be after dateTo" });

const bulkAssignManagerSchema = z
  .object({
    abandonmentIds: z.array(z.uuid()).min(1, "No abandoned leads selected"),
    method: z.enum(["MANUAL", "ROUND_ROBIN"]),
    managerId: z.uuid().optional(),
    managerIds: z.array(z.uuid()).optional(),
  })
  .refine((data) => (data.method === "MANUAL" ? Boolean(data.managerId) : Boolean(data.managerIds?.length)), {
    message: "managerId is required for manual assignment, managerIds is required for round robin",
  });

const bulkAssignSalespersonSchema = z
  .object({
    abandonmentIds: z.array(z.uuid()).min(1, "No abandoned leads selected"),
    method: z.enum(["MANUAL", "ROUND_ROBIN"]),
    salespersonId: z.uuid().optional(),
    salespersonIds: z.array(z.uuid()).optional(),
  })
  .refine((data) => (data.method === "MANUAL" ? Boolean(data.salespersonId) : Boolean(data.salespersonIds?.length)), {
    message: "salespersonId is required for manual assignment, salespersonIds is required for round robin",
  });

const createRecoveryActionSchema = z.object({
  type: z.enum(RecoveryActionType, { error: "Invalid recovery action type" }),
  status: optional(z.enum(RecoveryActionStatus, { error: "Invalid recovery action status" })),
  notes: optional(z.string().trim().max(2000, "notes must be 2000 characters or fewer")),
});

const updateStatusSchema = z.object({
  status: z.enum(AbandonmentStatus, { error: "Invalid abandonment status" }),
});

export const validateIdParams = (params: unknown) => validateSchema<{ id: string }>(idParams, params);
export const validateLeadIdParams = (params: unknown) => validateSchema<{ leadId: string }>(leadIdParams, params);
export const validateListAbandonmentsQuery = (query: unknown) => validateSchema<ListAbandonmentsQuery>(listQuerySchema, query);
export const validateCreateRecoveryAction = (body: unknown) => validateSchema<CreateRecoveryActionBody>(createRecoveryActionSchema, body);
export const validateUpdateStatus = (body: unknown) => validateSchema<UpdateAbandonmentStatusBody>(updateStatusSchema, body);
export const validateBulkAssignManager = (body: unknown) => validateSchema<BulkAssignManagerBody>(bulkAssignManagerSchema, body);
export const validateBulkAssignSalesperson = (body: unknown) => validateSchema<BulkAssignSalespersonBody>(bulkAssignSalespersonSchema, body);
