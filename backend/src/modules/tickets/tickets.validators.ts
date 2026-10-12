import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { TicketCategory, TicketPriority, TicketStatus } from "../../../generated/prisma/enums.js";

const idParamSchema = z.object({ id: z.string().uuid("Invalid ticket id") });

const createSchema = z.object({
  category: z.enum(TicketCategory, { message: "Invalid category" }),
  priority: z.enum(TicketPriority, { message: "Invalid priority" }).default("MEDIUM"),
  subject: z.string().trim().min(3, "Subject is required").max(200, "Subject is too long"),
  description: z.string().trim().min(10, "Describe the problem in a few words").max(5000, "Description is too long"),
});

const listQuerySchema = z.object({
  status: z.enum(TicketStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const commentSchema = z.object({ body: z.string().trim().min(1, "Comment cannot be empty").max(2000, "Comment is too long") });

const statusSchema = z.object({ status: z.enum(TicketStatus, { message: "Invalid status" }) });

export type CreateTicketBody = z.infer<typeof createSchema>;
export type ListTicketsQuery = z.infer<typeof listQuerySchema>;

export const validateIdParams = (params: unknown) => validateSchema<{ id: string }>(idParamSchema, params);
export const validateCreateBody = (body: unknown) => validateSchema<CreateTicketBody>(createSchema, body);
export const validateListQuery = (query: unknown) => validateSchema<ListTicketsQuery>(listQuerySchema, query);
export const validateCommentBody = (body: unknown) => validateSchema<{ body: string }>(commentSchema, body);
export const validateStatusBody = (body: unknown) => validateSchema<{ status: TicketStatus }>(statusSchema, body);
