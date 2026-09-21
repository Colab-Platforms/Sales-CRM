import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { WhatsAppProviderName, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import type { CreateTemplateInput, ListTemplatesQuery, UpdateTemplateInput } from "./whatsapp.template.types.js";

const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const name = z.string().trim().min(1, "name is required").max(150, "name must be 150 characters or fewer");
const body = z.string().trim().min(1, "body is required").max(4096, "body must be 4096 characters or fewer");
const language = z.string().trim().min(2, "language must be a valid language code").max(10, "language must be 10 characters or fewer");
const category = z.string().trim().max(50, "category must be 50 characters or fewer");

const createTemplateSchema = z.object({
  name,
  provider: z.enum(WhatsAppProviderName, { error: "Invalid provider" }),
  category: optional(category),
  language: language.default("en"),
  body,
});

const updateTemplateSchema = z
  .object({
    name: optional(name),
    category: optional(category),
    language: optional(language),
    body: optional(body),
    status: optional(z.enum(["DRAFT", "DISABLED"], { error: "status can only be set to DRAFT or DISABLED here - PENDING/APPROVED/REJECTED only ever come from a provider sync" })),
  })
  .refine((v) => Object.keys(v).length > 0, { error: "Provide at least one field to update" });

const page = z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1);
const pageSize = z.coerce.number({ error: "pageSize must be a number" }).int().min(1).max(100, "pageSize must be between 1 and 100").default(20);

const listTemplatesQuerySchema = z.object({
  page,
  pageSize,
  search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
  provider: optional(z.enum(WhatsAppProviderName, { error: "Invalid provider" })),
  status: optional(z.enum(WhatsAppTemplateStatus, { error: "Invalid status" })),
  category: optional(category),
  language: optional(language),
});

const templateIdParamsSchema = z.object({ id: z.uuid({ error: "Invalid template id" }) });

export const validateCreateTemplate = (body: unknown) => validateSchema<CreateTemplateInput>(createTemplateSchema, body);
export const validateUpdateTemplate = (body: unknown) => validateSchema<UpdateTemplateInput>(updateTemplateSchema, body);
export const validateListTemplatesQuery = (query: unknown) => validateSchema<ListTemplatesQuery>(listTemplatesQuerySchema, query);
export const validateTemplateIdParams = (params: unknown) => validateSchema<{ id: string }>(templateIdParamsSchema, params);
