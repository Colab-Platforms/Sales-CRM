import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { LoginBody } from "./auth.types.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const validateLoginSchema = (body: unknown) => validateSchema<LoginBody>(loginSchema, body);
