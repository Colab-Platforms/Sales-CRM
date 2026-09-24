import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { PaymentStatus } from "../../../generated/prisma/enums.js";
import { NO_PAYMENT } from "../orders/orders.types.js";
import type { ListReconciliationQuery } from "./reconciliation.types.js";

// The frontend omits empty filters, but treat `?paymentStatus=` as "not set" too.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const RECONCILIATION_STATUSES = ["PAID", "PARTIALLY_PAID", "PENDING", "FAILED", "REFUNDED", "PAYMENT_MISMATCH"] as const;

const listReconciliationQuerySchema = z
  .object({
    page: z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1),
    pageSize: z.coerce
      .number({ error: "pageSize must be a number" })
      .int()
      .min(1, "pageSize must be between 1 and 100")
      .max(100, "pageSize must be between 1 and 100")
      .default(20),
    search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
    paymentStatus: optional(z.enum([...Object.values(PaymentStatus), NO_PAYMENT], { error: "Invalid payment status" })),
    paymentMode: optional(z.enum(["COD", "PREPAID"], { error: "Invalid payment mode" })),
    reconciliationStatus: optional(z.enum(RECONCILIATION_STATUSES, { error: "Invalid reconciliation status" })),
    provider: optional(z.string().trim().max(100, "provider must be 100 characters or fewer")),
    dateFrom: optional(z.iso.datetime({ offset: true, error: "dateFrom must be an ISO date-time" }).transform((v) => new Date(v))),
    dateTo: optional(z.iso.datetime({ offset: true, error: "dateTo must be an ISO date-time" }).transform((v) => new Date(v))),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
    error: "dateFrom must not be after dateTo",
  });

export const validateListReconciliationQuery = (query: unknown) =>
  validateSchema<ListReconciliationQuery>(listReconciliationQuerySchema, query);
