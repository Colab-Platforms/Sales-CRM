import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { CreateWhatsAppCloudConfigBody } from "./whatsapp.cloud-config.types.js";

// A secret field may be blank/omitted when replacing an existing config (the stored value is kept);
// whether it is actually required depends on whether a decryptable config already exists, which only
// the service knows - see whatsapp.cloud-config.service.ts's createConfig.
const secret = z.string().max(2048).optional();

const credentialsSchema = z.object({
  accessToken: secret,
  appSecret: secret,
  verifyToken: secret,
});

// The model name ends up in the Gemini request path, so it is restricted to plain model-id characters.
const modelSchema = z.string().trim().max(100).regex(/^[A-Za-z0-9._-]*$/, "model may only contain letters, numbers, '.', '_' and '-'").optional();

const aiSchema = z.object({
  enabled: z.boolean(),
  provider: z.literal("gemini").optional(),
  model: modelSchema,
  geminiApiKey: secret,
});

const createSchema = z.object({
  phoneNumberId: z.string().min(1).max(64),
  businessAccountId: z.string().min(1).max(64),
  displayPhoneNumber: z.string().max(32).optional(),
  businessName: z.string().max(150).optional(),
  isActive: z.boolean().optional(),
  credentials: credentialsSchema,
  ai: aiSchema.optional(),
  confirmOverwrite: z.boolean().optional(),
});

export const validateCreateWhatsAppCloudConfigSchema = (body: unknown) =>
  validateSchema<CreateWhatsAppCloudConfigBody>(createSchema, body);
