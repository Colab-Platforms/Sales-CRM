import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { IncentivePolicyRules } from "./incentives.calc.js";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");

export const validateMonthQuery = (q: unknown) => validateSchema<{ month?: string }>(z.object({ month: month.optional() }), q);

export const validateMonthParams = (p: unknown) => validateSchema<{ userId: string; month: string }>(z.object({ userId: z.uuid({ error: "Invalid salesperson" }), month }), p);

const slab = z
  .object({
    minRevenue: z.number().positive(),
    amount: z.number().min(0).optional(),
    percent: z.number().positive().max(100).optional(),
  })
  .refine((s) => (s.amount === undefined) !== (s.percent === undefined), { message: "Each slab needs either an amount or a percentage" });

const policy = z.object({
  slabs: z.array(slab).min(1).max(20),
  percentBasis: z.enum(["TOTAL", "ABOVE_SLAB"]).nullable(),
  minPrepaidPercent: z.number().int().min(0).max(100),
  minDeliveryPercent: z.number().int().min(0).max(100),
  minAttendanceDays: z.number().int().min(0).max(31),
  minNetLoginMinutes: z.number().int().min(0).max(24 * 60),
  minLoginDays: z.number().int().min(0).max(31),
  minDailyCalls: z.number().int().min(0).max(10000),
  minCallDays: z.number().int().min(0).max(31),
  minAvgDailyOrders: z.number().min(0).max(1000),
});
export const validatePolicyBody = (b: unknown) => validateSchema<IncentivePolicyRules>(policy as z.ZodType<IncentivePolicyRules>, b);

export const validateApproveBody = (b: unknown) => validateSchema<{ note?: string }>(z.object({ note: z.string().trim().max(500).optional() }), b ?? {});

export const validatePaymentBody = (b: unknown) =>
  validateSchema<{ paymentRef?: string; note?: string; paidOn?: string }>(
    z.object({
      paymentRef: z.string().trim().max(120).optional(),
      note: z.string().trim().max(500).optional(),
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "paidOn must be YYYY-MM-DD").optional(),
    }),
    b ?? {},
  );

export const validateQueryBody = (b: unknown) => validateSchema<{ month: string; message: string }>(z.object({ month, message: z.string().trim().min(5, "Please describe the issue").max(1000) }), b);

export const validateResolveBody = (b: unknown) => validateSchema<{ response: string }>(z.object({ response: z.string().trim().min(2, "Write a reply").max(1000) }), b);

export const validateQueryList = (q: unknown) => validateSchema<{ status?: "OPEN" | "RESOLVED" }>(z.object({ status: z.enum(["OPEN", "RESOLVED"]).optional() }), q);

export const validateAuditQuery = (q: unknown) => validateSchema<{ userId?: string; month?: string }>(z.object({ userId: z.uuid().optional(), month: month.optional() }), q);
