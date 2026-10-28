import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { LoginBody } from "./auth.types.js";

const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1, "Enter your username"),
  password: z.string().min(6),
}).strict(); // an unexpected field (e.g. the old "email") is rejected, not silently ignored

export const validateLoginSchema = (body: unknown) => validateSchema<LoginBody>(loginSchema, body);
