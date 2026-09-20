import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { ActivitySource, ActivityType } from "../../../generated/prisma/enums.js";
import type { EntityAuditQuery, ListAuditQuery } from "./audit.types.js";

// The frontend omits empty filters, but treat `?type=` as "not set" too.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const page = z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1);
const pageSize = z.coerce
  .number({ error: "pageSize must be a number" })
  .int()
  .min(1, "pageSize must be between 1 and 100")
  .max(100, "pageSize must be between 1 and 100")
  .default(20);

// Entity types an audit row's referenceType can hold. Kept as a plain list (rather than a Prisma
// enum) since referenceType is an app-enforced polymorphic string, not a DB enum.
const REFERENCE_TYPES = ["Order", "Payment", "Shipment", "LeadAssignment", "LeadImportBatch", "WhatsAppMessage", "WhatsAppTemplate"] as const;

const listAuditQuerySchema = z
  .object({
    page,
    pageSize,
    search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
    dateFrom: optional(z.iso.datetime({ offset: true, error: "dateFrom must be an ISO date-time" }).transform((v) => new Date(v))),
    dateTo: optional(z.iso.datetime({ offset: true, error: "dateTo must be an ISO date-time" }).transform((v) => new Date(v))),
    type: optional(z.enum(ActivityType, { error: "Invalid audit event type" })),
    referenceType: optional(z.enum(REFERENCE_TYPES, { error: "Invalid entity type" })),
    actorId: optional(z.uuid({ error: "Invalid actor id" })),
    orderId: optional(z.uuid({ error: "Invalid order id" })),
    leadId: optional(z.uuid({ error: "Invalid customer id" })),
    source: optional(z.enum(ActivitySource, { error: "Invalid source" })),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
    error: "dateFrom must not be after dateTo",
  });

const entityAuditQuerySchema = z.object({ page, pageSize });

export const validateListAuditQuery = (query: unknown) => validateSchema<ListAuditQuery>(listAuditQuerySchema, query);

export const validateEntityAuditQuery = (query: unknown) => validateSchema<EntityAuditQuery>(entityAuditQuerySchema, query);
