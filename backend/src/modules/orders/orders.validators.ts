import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { OrderSource, OrderStatus, PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";
import { NO_PAYMENT, type CreateManualOrderInput, type ListOrdersQuery } from "./orders.types.js";

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

// Decimal columns are stored/sent as strings (see orders.types.ts's own Money comment) - this is the
// one shape check every money field in a manual order shares.
const money = (field: string) => z.string().regex(/^\d+(\.\d{1,2})?$/, `${field} must be a non-negative decimal amount`);

const createManualOrderItemSchema = z.object({
  productId: z.uuid({ error: "Invalid product id" }),
  variantId: z.uuid({ error: "Invalid variant id" }).optional(),
  quantity: z.coerce.number({ error: "quantity must be a number" }).int().min(1, "quantity must be at least 1"),
  unitPrice: money("unitPrice"),
  discountAmount: optional(money("discountAmount")),
});

const createManualOrderSchema = z.object({
  leadId: z.uuid({ error: "Invalid customer id" }),
  items: z.array(createManualOrderItemSchema).min(1, "At least one item is required").max(50, "Too many items"),
  paymentMethod: z.enum(PaymentMethod, { error: "Invalid payment method" }),
  shippingAddress: optional(
    z.object({
      name: optional(z.string().trim().max(200)),
      line1: optional(z.string().trim().max(255)),
      line2: optional(z.string().trim().max(255)),
      city: optional(z.string().trim().max(100)),
      state: optional(z.string().trim().max(100)),
      pincode: optional(z.string().trim().max(12)),
      phone: optional(z.string().trim().max(20)),
    }),
  ),
  shippingPincode: optional(z.string().trim().max(12)),
  shippingAmount: optional(money("shippingAmount")),
  discountAmount: optional(money("discountAmount")),
  discountReason: optional(z.string().trim().max(255)),
});

export const validateCreateManualOrder = (body: unknown) => validateSchema<CreateManualOrderInput>(createManualOrderSchema, body);

export const validateListOrdersQuery = (query: unknown) =>
  validateSchema<ListOrdersQuery>(listOrdersQuerySchema, query);

export const validateOrderIdParams = (params: unknown) =>
  validateSchema<{ id: string }>(orderIdParamsSchema, params);
