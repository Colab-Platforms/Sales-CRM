import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { CreateVirtualNumberBody, SubmitCallOutcomeBody, UpdateVirtualNumberBody } from "./calling.types.js";

const leadIdParamSchema = z.object({
  leadId: z.string().uuid(),
});

const callIdParamSchema = z.object({
  id: z.string().uuid(),
});

const initiateCallBodySchema = z.object({
  virtualNumberId: z.string().uuid(),
});

const submitCallOutcomeSchema = z.object({
  outcomeId: z.string().uuid(),
  notes: z.string().trim().max(2000).optional(),
  followUpAt: z.string().datetime({ offset: true }).optional(),
});

const virtualNumberIdParamSchema = z.object({
  id: z.string().uuid(),
});

const createVirtualNumberSchema = z.object({
  number: z.string().min(3).max(30),
  displayName: z.string().max(100).optional(),
  provider: z.string().min(1).max(100),
  providerNumberId: z.string().max(200).optional(),
  groupId: z.string().uuid().optional(),
});

const updateVirtualNumberSchema = z
  .object({
    displayName: z.string().max(100).optional(),
    provider: z.string().min(1).max(100).optional(),
    providerNumberId: z.string().max(200).optional(),
    groupId: z.string().uuid().optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

export const validateLeadIdParamSchema = (params: unknown) =>
  validateSchema<{ leadId: string }>(leadIdParamSchema, params);

export const validateCallIdParamSchema = (params: unknown) =>
  validateSchema<{ id: string }>(callIdParamSchema, params);

export const validateSubmitCallOutcomeSchema = (body: unknown) =>
  validateSchema<SubmitCallOutcomeBody>(submitCallOutcomeSchema, body);

export const validateInitiateCallBodySchema = (body: unknown) =>
  validateSchema<{ virtualNumberId: string }>(initiateCallBodySchema, body);

export const validateVirtualNumberIdParamSchema = (params: unknown) =>
  validateSchema<{ id: string }>(virtualNumberIdParamSchema, params);

export const validateCreateVirtualNumberSchema = (body: unknown) =>
  validateSchema<CreateVirtualNumberBody>(createVirtualNumberSchema, body);

export const validateUpdateVirtualNumberSchema = (body: unknown) =>
  validateSchema<UpdateVirtualNumberBody>(updateVirtualNumberSchema, body);
