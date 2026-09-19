import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { CreateManagerBody, UpdateManagerBody } from "./admin.types.js";

const createManagerSchema = z.object({
  name: z.string().min(2).max(150),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().max(20).optional(),
});

const updateManagerSchema = z
  .object({
    name: z.string().min(2).max(150).optional(),
    phone: z.string().max(20).optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

export const validateCreateManagerSchema = (body: unknown) =>
  validateSchema<CreateManagerBody>(createManagerSchema, body);

export const validateUpdateManagerSchema = (body: unknown) =>
  validateSchema<UpdateManagerBody>(updateManagerSchema, body);
