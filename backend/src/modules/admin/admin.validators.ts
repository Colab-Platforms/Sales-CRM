import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type {
  CreateManagerBody,
  CreateSalespersonBody,
  UpdateManagerBody,
  UpdateSalespersonBody,
} from "./admin.types.js";

const createManagerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long"),
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  phone: z.string().max(20, "Phone number is too long").optional(),
});

const createSalespersonSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long"),
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  phone: z.string().max(20, "Phone number is too long").optional(),
  // .guid() (not .uuid()) — Postgres's uuid column accepts any UUID-shaped
  // id regardless of RFC 9562 version/variant bits, which .uuid() enforces.
  reportingManagerId: z.string().guid("Select a reporting manager"),
});

const updateManagerSchema = z
  .object({
    name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long").optional(),
    phone: z.string().max(20, "Phone number is too long").optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

const updateSalespersonSchema = z
  .object({
    name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long").optional(),
    phone: z.string().max(20, "Phone number is too long").optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
    reportingManagerId: z.string().guid("Select a valid reporting manager").optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

export const validateCreateManagerSchema = (body: unknown) =>
  validateSchema<CreateManagerBody>(createManagerSchema, body);

export const validateCreateSalespersonSchema = (body: unknown) =>
  validateSchema<CreateSalespersonBody>(createSalespersonSchema, body);

export const validateUpdateManagerSchema = (body: unknown) =>
  validateSchema<UpdateManagerBody>(updateManagerSchema, body);

export const validateUpdateSalespersonSchema = (body: unknown) =>
  validateSchema<UpdateSalespersonBody>(updateSalespersonSchema, body);
