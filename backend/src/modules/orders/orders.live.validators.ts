import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { OrderSource, OrderStatus, PaymentStatus } from "../../../generated/prisma/enums.js";
import { NO_PAYMENT } from "./orders.types.js";
import type { LiveOrderHistoryQuery, LiveOrdersQuery } from "./orders.live.types.js";

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const liveOrdersQuerySchema = z
  .object({
    after: optional(z.string().trim().max(500, "after must be a valid cursor")),
    // 25-50 per the requirement ("Initial page should load only a small page") - never the whole
    // history, and never large enough to make the per-page CRM-lookup join expensive.
    first: z.coerce.number({ error: "first must be a number" }).int().min(1).max(50).default(25),
    search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
    dateFrom: optional(z.iso.datetime({ offset: true, error: "dateFrom must be an ISO date-time" }).transform((v) => new Date(v))),
    dateTo: optional(z.iso.datetime({ offset: true, error: "dateTo must be an ISO date-time" }).transform((v) => new Date(v))),
    status: optional(z.enum(OrderStatus, { error: "Invalid order status" })),
    paymentStatus: optional(z.enum([...Object.values(PaymentStatus), NO_PAYMENT], { error: "Invalid payment status" })),
    source: optional(z.enum(OrderSource, { error: "Invalid order source" })),
    salespersonId: optional(z.uuid({ error: "Invalid salesperson id" })),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
    error: "dateFrom must not be after dateTo",
  });

export const validateLiveOrdersQuery = (query: unknown) => validateSchema<LiveOrdersQuery>(liveOrdersQuerySchema, query);

const liveOrderHistoryQuerySchema = z.object({
  after: optional(z.string().trim().max(500, "after must be a valid cursor")),
  first: z.coerce.number({ error: "first must be a number" }).int().min(1).max(25).default(10),
});

export const validateLiveOrderHistoryQuery = (query: unknown) => validateSchema<LiveOrderHistoryQuery>(liveOrderHistoryQuerySchema, query);
