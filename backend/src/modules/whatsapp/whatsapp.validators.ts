import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { SendWhatsAppMessageInput } from "./whatsapp.types.js";

const sendMessageSchema = z.object({
  leadId: z.uuid({ error: "Invalid customer id" }),
  templateName: z.string().trim().min(1, "templateName is required").max(150, "templateName must be 150 characters or fewer"),
  params: z.array(z.string().max(1000, "each template param must be 1000 characters or fewer")).max(20, "at most 20 template params are supported").default([]),
});

export const validateSendMessageBody = (body: unknown) => validateSchema<SendWhatsAppMessageInput>(sendMessageSchema, body);
