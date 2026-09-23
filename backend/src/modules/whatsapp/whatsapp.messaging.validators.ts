import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { PreviewTemplateInput, SendOrderConfirmationTestInput, SendTemplateInput } from "./whatsapp.messaging.types.js";

const sendTemplateSchema = z.object({
  leadId: z.uuid({ error: "Invalid customer id" }),
  templateId: z.uuid({ error: "Invalid template id" }),
  orderId: z.uuid({ error: "Invalid order id" }).optional(),
  // Shape only here (non-empty string) - the real https/publicly-accessible check happens in the
  // service (assertValidMediaUrl), where it can give a specific, actionable error message.
  mediaUrl: z.string().trim().min(1, "mediaUrl must not be empty").max(2048).optional(),
  mediaFilename: z.string().trim().min(1).max(255).optional(),
});

export const validateSendTemplate = (body: unknown) => validateSchema<SendTemplateInput>(sendTemplateSchema, body);
export const validatePreviewTemplate = (body: unknown) => validateSchema<PreviewTemplateInput>(sendTemplateSchema, body);

// Deliberately just orderId - see SendOrderConfirmationTestInput.
const orderConfirmationTestSchema = z.object({
  orderId: z.uuid({ error: "Invalid order id" }),
});

export const validateOrderConfirmationTest = (body: unknown) => validateSchema<SendOrderConfirmationTestInput>(orderConfirmationTestSchema, body);
