import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type {
  CreateGroupBody,
  AddSalespersonBody,
  CreateSalespersonBody,
  AddExistingMemberBody,
  UpdateGroupBody,
  UpdateSalespersonBody,
} from "./manager.types.js";

const createGroupSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long"),
  description: z.string().max(1000, "Description is too long").optional(),
});

const addSalespersonSchema = z.object({
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
  // .guid() (not .uuid()) — .uuid() enforces RFC 9562 version/variant bits,
  // but Postgres's uuid column (and thus ids already in the database, e.g.
  // seeded groups) accepts any 32-hex-digit UUID regardless of those bits.
  groupId: z.string().guid("Select a group"),
});

const addExistingMemberSchema = z.object({
  userId: z.string().guid("Select a salesperson"),
});

const updateGroupSchema = z
  .object({
    name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long").optional(),
    description: z.string().max(1000, "Description is too long").optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

const updateSalespersonSchema = z
  .object({
    name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name is too long").optional(),
    phone: z.string().max(20, "Phone number is too long").optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

export const validateCreateGroupSchema = (body: unknown) => validateSchema<CreateGroupBody>(createGroupSchema, body);

export const validateAddSalespersonSchema = (body: unknown) =>
  validateSchema<AddSalespersonBody>(addSalespersonSchema, body);

export const validateCreateSalespersonSchema = (body: unknown) =>
  validateSchema<CreateSalespersonBody>(createSalespersonSchema, body);

export const validateAddExistingMemberSchema = (body: unknown) =>
  validateSchema<AddExistingMemberBody>(addExistingMemberSchema, body);

export const validateUpdateGroupSchema = (body: unknown) => validateSchema<UpdateGroupBody>(updateGroupSchema, body);

export const validateUpdateSalespersonSchema = (body: unknown) =>
  validateSchema<UpdateSalespersonBody>(updateSalespersonSchema, body);
