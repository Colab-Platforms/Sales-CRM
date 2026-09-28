import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { BulkClassifyInput, BulkSendInput } from "./whatsapp.bulk-send.types.js";

const bulkSendSchema = z.object({
  leadIds: z.array(z.uuid({ error: "Invalid customer id" })).min(1, "Select at least one chat").max(500, "Select 500 chats or fewer at a time"),
  templateId: z.uuid({ error: "Invalid template id" }),
  manualValues: z.record(z.string(), z.string().max(1000)).optional(),
});

export const validateBulkClassify = (body: unknown) => validateSchema<BulkClassifyInput>(bulkSendSchema, body);
export const validateBulkSend = (body: unknown) => validateSchema<BulkSendInput>(bulkSendSchema, body);
