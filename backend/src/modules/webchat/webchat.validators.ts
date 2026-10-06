import { z } from "zod";
import { ConversationMode } from "../../../generated/prisma/enums.js";
import { validateSchema } from "@/utils/validate.js";
import type { AssignWebChatConversationBody, ListWebChatConversationsQuery, SendWebChatAgentMessageBody } from "./webchat.types.js";

// Same convention as call.history.validators.ts: an empty string from the frontend means "not set".
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const coerceBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const listQuerySchema = z.object({
  page: z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1),
  limit: z.coerce
    .number({ error: "limit must be a number" })
    .int()
    .min(1, "limit must be between 1 and 100")
    .max(100, "limit must be between 1 and 100")
    .default(20),
  search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
  archived: optional(coerceBoolean),
  mode: optional(z.enum(ConversationMode, { error: "Invalid conversation mode" })),
  assigned: optional(coerceBoolean),
});

const idParamsSchema = z.object({
  id: z.uuid({ error: "Invalid conversation id" }),
});

const assignBodySchema = z.object({
  assignedToId: z.uuid({ error: "assignedToId must be a valid user id" }),
});

const sendMessageBodySchema = z.object({
  text: z.string().trim().min(1, "text is required").max(4000, "text must be 4000 characters or fewer"),
});

export const validateListWebChatQuery = (query: unknown) => validateSchema<ListWebChatConversationsQuery>(listQuerySchema, query);

export const validateWebChatIdParams = (params: unknown) => validateSchema<{ id: string }>(idParamsSchema, params);

export const validateAssignBody = (body: unknown) => validateSchema<AssignWebChatConversationBody>(assignBodySchema, body);

export const validateSendMessageBody = (body: unknown) => validateSchema<SendWebChatAgentMessageBody>(sendMessageBodySchema, body);
