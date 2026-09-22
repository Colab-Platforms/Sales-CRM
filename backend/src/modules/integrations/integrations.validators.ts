import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type {
  CreateSourceBody,
  UpdateSourceBody,
  ListSourcesQuery,
  ToggleSourceStatusBody,
  ListSourceEventsQuery,
} from "./integrations.types.js";

const sourceTypeEnum = z.enum(["MANUAL", "CSV", "META", "SHOPIFY", "API"]);
const sourceStatusEnum = z.enum(["ACTIVE", "INACTIVE"]);

const createSourceSchema = z.object({
  name: z.string().min(1).max(150),
  type: sourceTypeEnum,
  description: z.string().optional(),
  externalAccountId: z.string().max(255).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  credentials: z.record(z.string(), z.string()).optional(),
});

const updateSourceSchema = z
  .object({
    name: z.string().min(1).max(150).optional(),
    description: z.string().optional(),
    externalAccountId: z.string().max(255).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    credentials: z.record(z.string(), z.string()).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

const listSourcesQuerySchema = z.object({
  type: sourceTypeEnum.optional(),
  status: sourceStatusEnum.optional(),
});

const toggleSourceStatusSchema = z.object({
  status: sourceStatusEnum,
});

const listSourceEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const validateCreateSourceSchema = (body: unknown) =>
  validateSchema<CreateSourceBody>(createSourceSchema, body);

export const validateUpdateSourceSchema = (body: unknown) =>
  validateSchema<UpdateSourceBody>(updateSourceSchema, body);

export const validateListSourcesQuerySchema = (query: unknown) =>
  validateSchema<ListSourcesQuery>(listSourcesQuerySchema, query);

export const validateToggleSourceStatusSchema = (body: unknown) =>
  validateSchema<ToggleSourceStatusBody>(toggleSourceStatusSchema, body);

export const validateListSourceEventsQuerySchema = (query: unknown) =>
  validateSchema<ListSourceEventsQuery>(listSourceEventsQuerySchema, query);
