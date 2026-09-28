import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { WhatsAppDirection, WhatsAppMessageStatus, WhatsAppProviderName } from "../../../generated/prisma/enums.js";
import type { ListConversationsQuery, ListMessagesQuery } from "./whatsapp.history.types.js";

const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const listMessagesQuerySchema = z
  .object({
    page: z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1),
    pageSize: z.coerce.number({ error: "pageSize must be a number" }).int().min(1).max(100, "pageSize must be between 1 and 100").default(20),
    leadId: optional(z.uuid({ error: "Invalid customer id" })),
    direction: optional(z.enum(WhatsAppDirection, { error: "Invalid direction" })),
    status: optional(z.enum(WhatsAppMessageStatus, { error: "Invalid status" })),
    provider: optional(z.enum(WhatsAppProviderName, { error: "Invalid provider" })),
    templateId: optional(z.uuid({ error: "Invalid template id" })),
    orderId: optional(z.uuid({ error: "Invalid order id" })),
    dateFrom: optional(z.iso.datetime({ offset: true, error: "dateFrom must be an ISO date-time" }).transform((v) => new Date(v))),
    dateTo: optional(z.iso.datetime({ offset: true, error: "dateTo must be an ISO date-time" }).transform((v) => new Date(v))),
    search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, { error: "dateFrom must not be after dateTo" });

const messageIdParamsSchema = z.object({ id: z.uuid({ error: "Invalid message id" }) });

const listConversationsQuerySchema = z.object({
  page: z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1),
  pageSize: z.coerce.number({ error: "pageSize must be a number" }).int().min(1).max(100, "pageSize must be between 1 and 100").default(20),
  search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
  archived: optional(z.coerce.boolean()),
});

export const validateListMessagesQuery = (query: unknown) => validateSchema<ListMessagesQuery>(listMessagesQuerySchema, query);
export const validateMessageIdParams = (params: unknown) => validateSchema<{ id: string }>(messageIdParamsSchema, params);
export const validateListConversationsQuery = (query: unknown) => validateSchema<ListConversationsQuery>(listConversationsQuerySchema, query);
