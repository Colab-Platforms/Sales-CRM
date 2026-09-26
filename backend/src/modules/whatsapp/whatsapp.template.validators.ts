import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { WhatsAppProviderName, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import { extractTemplateVariables } from "./whatsapp.template.variables.js";
import type { CreateTemplateInput, ListTemplatesQuery, UpdateTemplateInput } from "./whatsapp.template.types.js";

const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

// lowercase letters, numbers and underscores only - the real constraint every provider's own template-name rule
// (Meta's "element_name", AiSensy/Gupshup's campaign name) shares, so a name accepted here is accepted everywhere.
const NAME_PATTERN = /^[a-z0-9_]+$/;
const name = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(150, "name must be 150 characters or fewer")
  .refine((v) => NAME_PATTERN.test(v), { error: "name can only contain lowercase letters, numbers and underscores (no spaces or other special characters)" });
const body = z.string().trim().min(1, "body is required").max(1024, "body must be 1024 characters or fewer (WhatsApp's own template body limit)");
const language = z.string().trim().min(2, "language must be a valid language code").max(10, "language must be 10 characters or fewer");
// Meta's own three template categories, for a template a person CREATES here - never invented, never extended.
// A SYNCED template's category is a free string on the model itself (provider-defined, not this module's to
// constrain), so the LIST filter below deliberately keeps the old loose string check instead of this enum.
const categoryEnum = z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"], { error: "category must be UTILITY, MARKETING or AUTHENTICATION" });
const categoryFilter = z.string().trim().max(50, "category must be 50 characters or fewer");

const headerSchema = z.object({
  type: z.enum(["TEXT", "IMAGE", "VIDEO", "DOCUMENT"], { error: "Invalid header type" }),
  text: optional(z.string().trim().max(60, "header text must be 60 characters or fewer")),
  mediaUrl: optional(z.url({ error: "header media reference must be a valid URL" }).max(2048)),
});

const BUTTON_TEXT_MAX = 25; // Meta/AiSensy's own shared button-label limit
const buttonSchema = z
  .object({
    type: z.enum(["QUICK_REPLY", "URL", "PHONE_NUMBER"], { error: "Invalid button type" }),
    text: z.string().trim().min(1, "button text is required").max(BUTTON_TEXT_MAX, `button text must be ${BUTTON_TEXT_MAX} characters or fewer`),
    url: optional(z.url({ error: "button URL must be valid" }).max(2048)),
    dynamic: optional(z.boolean()),
    phoneNumber: optional(z.string().trim().regex(/^\+?[1-9]\d{6,14}$/, "phone number must be a valid E.164 number, e.g. +919876543210")),
  })
  .refine((b) => b.type !== "URL" || Boolean(b.url), { error: "a URL button needs a URL", path: ["url"] })
  .refine((b) => b.type !== "PHONE_NUMBER" || Boolean(b.phoneNumber), { error: "a phone-number button needs a phone number", path: ["phoneNumber"] });

// At most 3 buttons total (Meta's own cap) and never a mix of a URL/phone CTA with quick replies in the same
// template (Meta's real rule: quick replies and CTAs are mutually exclusive button groups).
const buttonsSchema = z
  .array(buttonSchema)
  .max(3, "a template can have at most 3 buttons")
  .refine((buttons) => {
    const kinds = new Set(buttons.map((b) => (b.type === "QUICK_REPLY" ? "QUICK_REPLY" : "CTA")));
    return kinds.size <= 1;
  }, { error: "quick-reply buttons cannot be mixed with URL/phone-number buttons in the same template" });

const componentsSchema = z.object({
  header: optional(headerSchema),
  footer: optional(z.string().trim().max(60, "footer must be 60 characters or fewer")),
  buttons: optional(buttonsSchema),
  bodyExamples: optional(z.record(z.string(), z.string().max(200))),
});

// A bodyExample must name a variable that is actually in the body - otherwise it is silent dead data (or, worse,
// a copy-paste mistake describing a variable that no longer exists after an edit).
function bodyExamplesMatchBody(bodyText: string | undefined, components: { bodyExamples?: Record<string, string> } | null | undefined): boolean {
  if (!components?.bodyExamples || bodyText === undefined) return true;
  const known = new Set(extractTemplateVariables(bodyText).variables);
  return Object.keys(components.bodyExamples).every((k) => known.has(k));
}

const createTemplateSchema = z
  .object({
    name,
    provider: z.enum(WhatsAppProviderName, { error: "Invalid provider" }),
    category: optional(categoryEnum),
    language: language.default("en"),
    body,
    components: optional(componentsSchema),
  })
  .refine((v) => bodyExamplesMatchBody(v.body, v.components), { error: "a body example refers to a variable that is not in the body", path: ["components", "bodyExamples"] });

const updateTemplateSchema = z
  .object({
    name: optional(name),
    category: optional(categoryEnum),
    language: optional(language),
    body: optional(body),
    components: optional(componentsSchema.nullable()),
    status: optional(z.enum(["DRAFT", "DISABLED"], { error: "status can only be set to DRAFT or DISABLED here - PENDING/APPROVED/REJECTED only ever come from a provider sync" })),
  })
  .refine((v) => Object.keys(v).length > 0, { error: "Provide at least one field to update" })
  .refine((v) => bodyExamplesMatchBody(v.body, v.components), { error: "a body example refers to a variable that is not in the body", path: ["components", "bodyExamples"] });

const page = z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1);
const pageSize = z.coerce.number({ error: "pageSize must be a number" }).int().min(1).max(100, "pageSize must be between 1 and 100").default(20);

const listTemplatesQuerySchema = z.object({
  page,
  pageSize,
  search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
  provider: optional(z.enum(WhatsAppProviderName, { error: "Invalid provider" })),
  status: optional(z.enum(WhatsAppTemplateStatus, { error: "Invalid status" })),
  category: optional(categoryFilter),
  language: optional(language),
});

const templateIdParamsSchema = z.object({ id: z.uuid({ error: "Invalid template id" }) });

export const validateCreateTemplate = (body: unknown) => validateSchema<CreateTemplateInput>(createTemplateSchema, body);
export const validateUpdateTemplate = (body: unknown) => validateSchema<UpdateTemplateInput>(updateTemplateSchema, body);
export const validateListTemplatesQuery = (query: unknown) => validateSchema<ListTemplatesQuery>(listTemplatesQuerySchema, query);
export const validateTemplateIdParams = (params: unknown) => validateSchema<{ id: string }>(templateIdParamsSchema, params);
