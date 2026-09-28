import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { AbandonmentStatus, AbandonmentType, RecoveryActionStatus, RecoveryActionType } from "../../../generated/prisma/enums.js";
import type { CreateRecoveryActionBody, ListAbandonmentsQuery, UpdateAbandonmentStatusBody } from "./abandonment.types.js";

const idParams = z.object({ id: z.uuid({ error: "Invalid abandonment id" }) });

// `?status=` from an unset filter is treated the same as absent - same convention as shiprocket.validators.ts.
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const listQuerySchema = z
  .object({
    page: z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1),
    pageSize: z.coerce.number({ error: "pageSize must be a number" }).int().min(1, "pageSize must be between 1 and 100").max(100, "pageSize must be between 1 and 100").default(25),
    search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
    status: optional(z.enum(AbandonmentStatus, { error: "Invalid abandonment status" })),
    type: optional(z.enum(AbandonmentType, { error: "Invalid abandonment type" })),
    dateFrom: optional(z.iso.datetime({ offset: true, error: "dateFrom must be an ISO date-time" }).transform((v) => new Date(v))),
    dateTo: optional(z.iso.datetime({ offset: true, error: "dateTo must be an ISO date-time" }).transform((v) => new Date(v))),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, { error: "dateFrom must not be after dateTo" });

const createRecoveryActionSchema = z.object({
  type: z.enum(RecoveryActionType, { error: "Invalid recovery action type" }),
  status: optional(z.enum(RecoveryActionStatus, { error: "Invalid recovery action status" })),
  notes: optional(z.string().trim().max(2000, "notes must be 2000 characters or fewer")),
});

const updateStatusSchema = z.object({
  status: z.enum(AbandonmentStatus, { error: "Invalid abandonment status" }),
});

export const validateIdParams = (params: unknown) => validateSchema<{ id: string }>(idParams, params);
export const validateListAbandonmentsQuery = (query: unknown) => validateSchema<ListAbandonmentsQuery>(listQuerySchema, query);
export const validateCreateRecoveryAction = (body: unknown) => validateSchema<CreateRecoveryActionBody>(createRecoveryActionSchema, body);
export const validateUpdateStatus = (body: unknown) => validateSchema<UpdateAbandonmentStatusBody>(updateStatusSchema, body);
