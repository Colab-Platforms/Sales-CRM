import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { WorkStatus } from "../../../generated/prisma/enums.js";
import type { ReportQuery, SetStatusBody } from "./attendance.types.js";

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
