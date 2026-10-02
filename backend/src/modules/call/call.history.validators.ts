import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { CallDirection, CallStatus } from "../../../generated/prisma/enums.js";
import type { CallSummaryQuery, ListCallsQuery } from "./call.history.types.js";

// The frontend omits empty filters, but treat `?status=` etc. as "not set" too (same convention as
// orders.validators.ts).
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

// The frontend's date filters are plain <input type="date"> values (yyyy-mm-dd, no time/zone).
// dateTo is end-of-day so the selected day itself is included, not excluded, by the `lte`.
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "must be a date in yyyy-mm-dd format" });

const coerceBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

// Shared by both `GET /api/calls` (list, paginated) and `GET /api/calls/summary` (aggregate, no
// pagination) - the IVR reporting pages use the exact same filter set for both.
const callFiltersSchema = {
  search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
  status: optional(z.enum(CallStatus, { error: "Invalid call status" })),
  direction: optional(z.enum(CallDirection, { error: "Invalid call direction" })),
  dateFrom: optional(dateOnly.transform((v) => new Date(`${v}T00:00:00.000Z`))),
  dateTo: optional(dateOnly.transform((v) => new Date(`${v}T23:59:59.999Z`))),
  agentId: optional(z.uuid({ error: "Invalid agent id" })),
  virtualNumberId: optional(z.uuid({ error: "Invalid virtual number id" })),
  hasRecording: optional(coerceBoolean),
};

const listCallsQuerySchema = z.object({
  page: z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1),
  limit: z.coerce
    .number({ error: "limit must be a number" })
    .int()
    .min(1, "limit must be between 1 and 100")
    .max(100, "limit must be between 1 and 100")
    .default(20),
  ...callFiltersSchema,
});

const callSummaryQuerySchema = z.object(callFiltersSchema);

const callIdParamsSchema = z.object({
  id: z.uuid({ error: "Invalid call id" }),
});

export const validateListCallsQuery = (query: unknown) => validateSchema<ListCallsQuery>(listCallsQuerySchema, query);

export const validateCallSummaryQuery = (query: unknown) => validateSchema<CallSummaryQuery>(callSummaryQuerySchema, query);

export const validateCallIdParams = (params: unknown) => validateSchema<{ id: string }>(callIdParamsSchema, params);
