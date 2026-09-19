import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type {
  CreateGroupBody,
  AddSalespersonBody,
  AddExistingMemberBody,
  UpdateGroupBody,
  UpdateSalespersonBody,
} from "./manager.types.js";

const createGroupSchema = z.object({
  name: z.string().min(2).max(150),
  description: z.string().max(1000).optional(),
});

const addSalespersonSchema = z.object({
  name: z.string().min(2).max(150),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().max(20).optional(),
});

const addExistingMemberSchema = z.object({
  userId: z.string().uuid(),
});

const updateGroupSchema = z
  .object({
    name: z.string().min(2).max(150).optional(),
    description: z.string().max(1000).optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

const updateSalespersonSchema = z
  .object({
    name: z.string().min(2).max(150).optional(),
    phone: z.string().max(20).optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

export const validateCreateGroupSchema = (body: unknown) => validateSchema<CreateGroupBody>(createGroupSchema, body);

export const validateAddSalespersonSchema = (body: unknown) =>
  validateSchema<AddSalespersonBody>(addSalespersonSchema, body);

export const validateAddExistingMemberSchema = (body: unknown) =>
  validateSchema<AddExistingMemberBody>(addExistingMemberSchema, body);

export const validateUpdateGroupSchema = (body: unknown) => validateSchema<UpdateGroupBody>(updateGroupSchema, body);

export const validateUpdateSalespersonSchema = (body: unknown) =>
  validateSchema<UpdateSalespersonBody>(updateSalespersonSchema, body);
