import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { WhatsAppAutomationType } from "../../../generated/prisma/enums.js";
import type { UpdateAutomationConfigInput } from "./whatsapp.automation.types.js";

const updateAutomationConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    // Explicit null clears the configured template; the key being absent leaves it unchanged -
    // z.optional() alone cannot tell "omitted" from "null", so templateId is nullable() too.
    templateId: z.uuid({ error: "Invalid template id" }).nullable().optional(),
  })
  .refine((v) => v.enabled !== undefined || v.templateId !== undefined, { error: "Provide at least one field to update" });

const automationTypeParamsSchema = z.object({ automationType: z.enum(WhatsAppAutomationType, { error: "Invalid automation type" }) });

export const validateUpdateAutomationConfig = (body: unknown) => validateSchema<UpdateAutomationConfigInput>(updateAutomationConfigSchema, body);
export const validateAutomationTypeParams = (params: unknown) => validateSchema<{ automationType: string }>(automationTypeParamsSchema, params);
