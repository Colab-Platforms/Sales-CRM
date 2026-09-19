import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { ListCustomerTimelineQuery } from "./customers.types.js";

const customerIdParamsSchema = z.object({
  leadId: z.uuid({ error: "Invalid customer id" }),
});

const listTimelineQuerySchema = z.object({
  page: z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1),
  pageSize: z.coerce
    .number({ error: "pageSize must be a number" })
    .int()
    .min(1, "pageSize must be between 1 and 100")
    .max(100, "pageSize must be between 1 and 100")
    .default(20),
});

export const validateCustomerIdParams = (params: unknown) =>
  validateSchema<{ leadId: string }>(customerIdParamsSchema, params);

export const validateListTimelineQuery = (query: unknown) =>
  validateSchema<ListCustomerTimelineQuery>(listTimelineQuerySchema, query);
