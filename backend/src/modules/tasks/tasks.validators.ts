import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";

const taskIdParamSchema = z.object({
  id: z.string().uuid(),
});

const snoozeTaskSchema = z.object({
  minutes: z.coerce.number().int().min(1).max(24 * 60),
});

export const validateTaskIdParamSchema = (params: unknown) => validateSchema<{ id: string }>(taskIdParamSchema, params);

export const validateSnoozeTaskSchema = (body: unknown) => validateSchema<{ minutes: number }>(snoozeTaskSchema, body);
