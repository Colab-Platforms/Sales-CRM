import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { ListRefundRequestsQuery } from "./refunds.types.js";

export const MAX_REASON_LENGTH = 1000;
export const MAX_NOTE_LENGTH = 1000;

const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

// An amount is a plain money string/number with at most 2 decimals. It is only checked for SHAPE here; whether it fits the payment's
// refundable balance is decided by the server from the database, never from anything the browser computed.
const amountSchema = z
  .union([z.string(), z.number()], { error: "Enter the refund amount" })
  .transform((v) => String(v).trim())
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), "Enter a valid amount (up to 2 decimals)")
  .refine((v) => Number(v) > 0, "The refund amount must be greater than 0");

const createBodySchema = z.object({
  paymentId: z.uuid({ error: "Choose the payment to refund" }),
  amount: amountSchema,
  reason: z
    .string({ error: "A reason is required" })
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, "A reason is required")
    .refine((v) => v.length <= MAX_REASON_LENGTH, `The reason must be at most ${MAX_REASON_LENGTH} characters`),
  submissionKey: optional(z.string().trim().min(8, "Invalid submission key").max(100, "Invalid submission key")),
});

const decisionBodySchema = z.object({
  note: optional(z.string().transform((v) => v.trim()).refine((v) => v.length <= MAX_NOTE_LENGTH, `The note must be at most ${MAX_NOTE_LENGTH} characters`)),
});

const rejectBodySchema = z.object({
  note: z
    .string({ error: "A rejection reason is required" })
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, "A rejection reason is required")
    .refine((v) => v.length <= MAX_NOTE_LENGTH, `The rejection reason must be at most ${MAX_NOTE_LENGTH} characters`),
});

const orderParamsSchema = z.object({ orderId: z.uuid({ error: "Invalid order id" }) });
const idParamsSchema = z.object({ id: z.uuid({ error: "Invalid refund request id" }) });

const listQuerySchema = z.object({
  status: optional(z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"], { error: "Invalid status" })).default("PENDING"),
  orderId: optional(z.uuid({ error: "Invalid order id" })),
  requestedById: optional(z.uuid({ error: "Invalid requester id" })),
  from: optional(z.coerce.date({ error: "Invalid from date" })),
  to: optional(z.coerce.date({ error: "Invalid to date" })),
  page: z.coerce.number({ error: "page must be a number" }).int().min(1).default(1),
  pageSize: z.coerce.number({ error: "pageSize must be a number" }).int().min(1).max(100, "pageSize must be between 1 and 100").default(20),
});

export const validateCreateBody = (body: unknown) => validateSchema<{ paymentId: string; amount: string; reason: string; submissionKey?: string }>(createBodySchema, body ?? {});
export const validateDecisionBody = (body: unknown) => validateSchema<{ note?: string }>(decisionBodySchema, body ?? {});
export const validateRejectBody = (body: unknown) => validateSchema<{ note: string }>(rejectBodySchema, body ?? {});
const orderPaymentParamsSchema = z.object({ orderId: z.uuid({ error: "Invalid order id" }), paymentId: z.uuid({ error: "Invalid payment id" }) });
export const validateOrderPaymentParams = (params: unknown) => validateSchema<{ orderId: string; paymentId: string }>(orderPaymentParamsSchema, params);
export const validateOrderParams = (params: unknown) => validateSchema<{ orderId: string }>(orderParamsSchema, params);
export const validateIdParams = (params: unknown) => validateSchema<{ id: string }>(idParamsSchema, params);
export const validateListQuery = (query: unknown) => validateSchema<ListRefundRequestsQuery>(listQuerySchema as never, query);
