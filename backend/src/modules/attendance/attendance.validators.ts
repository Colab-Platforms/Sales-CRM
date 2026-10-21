import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { WorkStatus } from "../../../generated/prisma/enums.js";
import type { BreakLimitBody, BreakLimitQuery, ReportQuery, SetStatusBody } from "./attendance.types.js";

const setStatusSchema = z.object({
  status: z.enum(WorkStatus, { message: "Invalid status" }),
});

const reportQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
  userId: z.string().uuid().optional(),
});

export const validateSetStatusSchema = (body: unknown) => validateSchema<SetStatusBody>(setStatusSchema, body);

export const validateReportQuerySchema = (query: unknown) => validateSchema<ReportQuery>(reportQuerySchema, query);

const breakLimitQuerySchema = z.object({ managerId: z.string().uuid().optional() });

const breakLimitBodySchema = z.object({
  maxConcurrentBreaks: z
    .number({ message: "maxConcurrentBreaks must be a number or null" })
    .int("maxConcurrentBreaks must be a whole number")
    .min(0, "maxConcurrentBreaks cannot be negative")
    .max(1000)
    .nullable(),
  managerId: z.string().uuid().optional(),
});

export const validateBreakLimitQuerySchema = (query: unknown) =>
  validateSchema<BreakLimitQuery>(breakLimitQuerySchema, query);

export const validateBreakLimitBodySchema = (body: unknown) =>
  validateSchema<BreakLimitBody>(breakLimitBodySchema, body);
