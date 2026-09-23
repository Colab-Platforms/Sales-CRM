import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { PaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import { NO_PAYMENT } from "./customers.money.js";
import type { ListCustomerTimelineQuery, ListCustomersQuery } from "./customers.types.js";

const SEGMENTS = ["NEW", "HOT", "REPEAT", "VIP", "DORMANT", "AT_RISK"] as const;

const NBA_ACTIONS = [
  "FOLLOW_UP_PAYMENT",
  "TRACK_SHIPMENT",
  "FOLLOW_UP_DELIVERY",
  "HANDLE_RETURN",
  "RETENTION_FOLLOW_UP",
  "REPEAT_PURCHASE_FOLLOW_UP",
  "HIGH_VALUE_CUSTOMER_FOLLOW_UP",
  "INTERESTED_LEAD_FOLLOW_UP",
  "GENERAL_FOLLOW_UP",
  "NO_ACTION",
] as const;

const NBA_PRIORITIES = ["HIGH", "MEDIUM", "LOW", "NONE"] as const;

// The frontend omits empty filters, but treat `?segment=` as "not set" too.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

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

const listCustomersQuerySchema = z
  .object({
    page: z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1),
    pageSize: z.coerce
      .number({ error: "pageSize must be a number" })
      .int()
      .min(1, "pageSize must be between 1 and 100")
      .max(100, "pageSize must be between 1 and 100")
      .default(20),
    search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
    segment: optional(z.enum(SEGMENTS, { error: "Invalid segment" })),
    ownerId: optional(z.uuid({ error: "Invalid owner id" })),
    hasOrders: optional(z.enum(["true", "false"]).transform((v) => v === "true")),
    paymentStatus: optional(z.enum([...Object.values(PaymentStatus), NO_PAYMENT], { error: "Invalid payment status" })),
    shipmentStatus: optional(z.enum(ShipmentStatus, { error: "Invalid shipment status" })),
    nbaAction: optional(z.enum(NBA_ACTIONS, { error: "Invalid next-best-action" })),
    nbaPriority: optional(z.enum(NBA_PRIORITIES, { error: "Invalid priority" })),
    dateFrom: optional(z.iso.datetime({ offset: true, error: "dateFrom must be an ISO date-time" }).transform((v) => new Date(v))),
    dateTo: optional(z.iso.datetime({ offset: true, error: "dateTo must be an ISO date-time" }).transform((v) => new Date(v))),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
    error: "dateFrom must not be after dateTo",
  });

export const validateListCustomersQuery = (query: unknown) =>
  validateSchema<ListCustomersQuery>(listCustomersQuerySchema, query);
