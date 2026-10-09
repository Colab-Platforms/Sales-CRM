import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { CreateMembershipRequestBody, DecisionBody, ListMembershipRequestsQuery } from "./group-membership-requests.types.js";

const createRequestSchema = z.object({
  groupId: z.string().guid("Select a group"),
  salespersonId: z.string().guid("Select a salesperson"),
  note: z.string().trim().max(1000, "Note is too long").optional(),
});

const decisionSchema = z.object({
  note: z.string().trim().max(1000, "Note is too long").optional(),
});

const rejectDecisionSchema = z.object({
  note: z.string().trim().min(1, "A reason is required").max(1000, "Note is too long"),
});

const listQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"]).optional().default("ALL"),
});

export const validateCreateMembershipRequestSchema = (body: unknown) =>
  validateSchema<CreateMembershipRequestBody>(createRequestSchema, body);

export const validateDecisionSchema = (body: unknown) => validateSchema<DecisionBody>(decisionSchema, body);

export const validateRejectDecisionSchema = (body: unknown) => validateSchema<DecisionBody>(rejectDecisionSchema, body);

export const validateListMembershipRequestsQuery = (query: unknown) =>
  validateSchema<ListMembershipRequestsQuery>(listQuerySchema, query);
