import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { usernameSchema } from "@/lib/username.js";
import type {
  CreateManagerBody,
  CreateSalespersonBody,
  ResetPasswordBody,
  UpdateManagerBody,
  UpdateSalespersonBody,
  CreateHrBody,
  CreateGroupBody,
  UpdateGroupBody,
  AddSalespersonBody,
  AddExistingMemberBody,
} from "./admin.types.js";

const createManagerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long"),
  username: usernameSchema,
  password: z.string().min(6, "Password must be at least 6 characters"),
  phone: z.string().trim().min(7, "Enter a valid phone number").max(20, "Phone number is too long"),
});

const createHrSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long"),
  username: usernameSchema,
  password: z.string().min(6, "Password must be at least 6 characters"),
  phone: z.string().trim().min(7, "Enter a valid phone number").max(20, "Phone number is too long"),
});

const createGroupSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long"),
  description: z.string().max(1000, "Description is too long").optional(),
  managerId: z.string().guid("Select a manager"),
});

const updateGroupSchema = z
  .object({
    name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long").optional(),
    description: z.string().max(1000, "Description is too long").optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
    managerId: z.string().guid("Select a valid manager").optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

const addSalespersonSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long"),
  username: usernameSchema,
  password: z.string().min(6, "Password must be at least 6 characters"),
  phone: z.string().trim().min(7, "Enter a valid phone number").max(20, "Phone number is too long"),
});

const addExistingMemberSchema = z.object({
  userId: z.string().guid("Select a salesperson"),
});

const createSalespersonSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long"),
  username: usernameSchema,
  password: z.string().min(6, "Password must be at least 6 characters"),
  phone: z.string().trim().min(7, "Enter a valid phone number").max(20, "Phone number is too long"),
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

const resetPasswordSchema = z.object({
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export const validateCreateManagerSchema = (body: unknown) =>
  validateSchema<CreateManagerBody>(createManagerSchema, body);

export const validateResetPasswordSchema = (body: unknown) =>
  validateSchema<ResetPasswordBody>(resetPasswordSchema, body);

export const validateCreateSalespersonSchema = (body: unknown) =>
  validateSchema<CreateSalespersonBody>(createSalespersonSchema, body);

export const validateUpdateManagerSchema = (body: unknown) =>
  validateSchema<UpdateManagerBody>(updateManagerSchema, body);

export const validateUpdateSalespersonSchema = (body: unknown) =>
  validateSchema<UpdateSalespersonBody>(updateSalespersonSchema, body);

export const validateCreateHrSchema = (body: unknown) => validateSchema<CreateHrBody>(createHrSchema, body);

export const validateCreateGroupSchema = (body: unknown) => validateSchema<CreateGroupBody>(createGroupSchema, body);

export const validateUpdateGroupSchema = (body: unknown) => validateSchema<UpdateGroupBody>(updateGroupSchema, body);

export const validateAddSalespersonSchema = (body: unknown) =>
  validateSchema<AddSalespersonBody>(addSalespersonSchema, body);

export const validateAddExistingMemberSchema = (body: unknown) =>
  validateSchema<AddExistingMemberBody>(addExistingMemberSchema, body);
