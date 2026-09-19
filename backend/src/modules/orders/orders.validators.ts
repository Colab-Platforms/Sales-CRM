import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { OrderSource, OrderStatus, PaymentStatus } from "../../../generated/prisma/enums.js";
import { NO_PAYMENT, type ListOrdersQuery } from "./orders.types.js";

// The frontend omits empty filters, but treat `?status=` as "not set" too.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const listOrdersQuerySchema = z
  .object({
    page: z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1),
    pageSize: z.coerce
      .number({ error: "pageSize must be a number" })
      .int()
      .min(1, "pageSize must be between 1 and 100")
      .max(100, "pageSize must be between 1 and 100")
      .default(20),
    search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
    status: optional(z.enum(OrderStatus, { error: "Invalid order status" })),
    paymentStatus: optional(z.enum([...Object.values(PaymentStatus), NO_PAYMENT], { error: "Invalid payment status" })),
    source: optional(z.enum(OrderSource, { error: "Invalid order source" })),
    salespersonId: optional(z.uuid({ error: "Invalid salesperson id" })),
    dateFrom: optional(z.iso.datetime({ offset: true, error: "dateFrom must be an ISO date-time" }).transform((v) => new Date(v))),
    dateTo: optional(z.iso.datetime({ offset: true, error: "dateTo must be an ISO date-time" }).transform((v) => new Date(v))),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
    error: "dateFrom must not be after dateTo",
  });

const orderIdParamsSchema = z.object({
  id: z.uuid({ error: "Invalid order id" }),
});

export const validateListOrdersQuery = (query: unknown) =>
  validateSchema<ListOrdersQuery>(listOrdersQuerySchema, query);

export const validateOrderIdParams = (params: unknown) =>
  validateSchema<{ id: string }>(orderIdParamsSchema, params);
