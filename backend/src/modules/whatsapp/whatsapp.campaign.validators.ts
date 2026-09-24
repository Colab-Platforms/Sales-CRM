import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { PaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import { NO_PAYMENT } from "../orders/orders.types.js";
import type {
  AudienceFilters,
  CreateCampaignInput,
  LaunchCampaignInput,
  ListCampaignRecipientsQuery,
  ListCampaignsQuery,
  UpdateCampaignInput,
} from "./whatsapp.campaign.types.js";

const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const name = z.string().trim().min(1, "name is required").max(150, "name must be 150 characters or fewer");
const description = z.string().trim().max(1000, "description must be 1000 characters or fewer");

const SEGMENTS = ["NEW", "HOT", "REPEAT", "VIP", "DORMANT", "AT_RISK"] as const;
const NBA_ACTIONS = [
  "FOLLOW_UP_PAYMENT", "TRACK_SHIPMENT", "FOLLOW_UP_DELIVERY", "HANDLE_RETURN", "RETENTION_FOLLOW_UP",
  "REPEAT_PURCHASE_FOLLOW_UP", "HIGH_VALUE_CUSTOMER_FOLLOW_UP", "INTERESTED_LEAD_FOLLOW_UP", "GENERAL_FOLLOW_UP", "NO_ACTION",
] as const;
const NBA_PRIORITIES = ["HIGH", "MEDIUM", "LOW", "NONE"] as const;

// The exact same filter vocabulary customers.validators.ts's ListCustomersQuery schema already
// validates (AudienceFilters IS ListCustomersQuery minus page/pageSize) - kept as its own schema,
// not imported, so this module never depends on another module's route-layer validators.
const audienceFiltersSchema = z.object({
  search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
  segment: optional(z.enum(SEGMENTS, { error: "Invalid segment" })),
  ownerId: optional(z.uuid({ error: "Invalid owner id" })),
  hasOrders: optional(z.coerce.boolean()),
  paymentStatus: optional(z.enum([...Object.values(PaymentStatus), NO_PAYMENT], { error: "Invalid payment status" })),
  shipmentStatus: optional(z.enum(ShipmentStatus, { error: "Invalid shipment status" })),
  nbaAction: optional(z.enum(NBA_ACTIONS, { error: "Invalid next-best-action" })),
  nbaPriority: optional(z.enum(NBA_PRIORITIES, { error: "Invalid priority" })),
  dateFrom: optional(z.iso.datetime({ offset: true, error: "dateFrom must be an ISO date-time" }).transform((v) => new Date(v))),
  dateTo: optional(z.iso.datetime({ offset: true, error: "dateTo must be an ISO date-time" }).transform((v) => new Date(v))),
}) satisfies z.ZodType<AudienceFilters>;

const createCampaignSchema = z.object({
  name,
  description: optional(description),
  templateId: z.uuid({ error: "Invalid template id" }),
  filters: audienceFiltersSchema.default({}),
});

const updateCampaignSchema = z
  .object({
    name: optional(name),
    description: optional(description),
    templateId: optional(z.uuid({ error: "Invalid template id" })),
    filters: optional(audienceFiltersSchema),
  })
  .refine((v) => Object.keys(v).length > 0, { error: "Provide at least one field to update" });

const launchCampaignSchema = z.object({ scheduledAt: optional(z.iso.datetime({ offset: true, error: "scheduledAt must be an ISO date-time" }).transform((v) => new Date(v))) });

const page = z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1);
const pageSize = z.coerce.number({ error: "pageSize must be a number" }).int().min(1).max(100, "pageSize must be between 1 and 100").default(20);

const campaignStatusEnum = z.enum(["DRAFT", "SCHEDULED", "RUNNING", "COMPLETED", "CANCELLED", "FAILED"]);
const recipientStatusEnum = z.enum(["PENDING", "CLAIMED", "SENT", "SKIPPED", "FAILED"]);

const listCampaignsQuerySchema = z.object({ page, pageSize, status: optional(campaignStatusEnum) });
const listRecipientsQuerySchema = z.object({ page, pageSize, status: optional(recipientStatusEnum) });
const campaignIdParamsSchema = z.object({ id: z.uuid({ error: "Invalid campaign id" }) });

export const validateAudienceFilters = (body: unknown) => validateSchema<AudienceFilters>(audienceFiltersSchema, body);
export const validateCreateCampaign = (body: unknown) => validateSchema<CreateCampaignInput>(createCampaignSchema, body);
export const validateUpdateCampaign = (body: unknown) => validateSchema<UpdateCampaignInput>(updateCampaignSchema, body);
export const validateLaunchCampaign = (body: unknown) => validateSchema<LaunchCampaignInput>(launchCampaignSchema, body);
export const validateListCampaignsQuery = (query: unknown) => validateSchema<ListCampaignsQuery>(listCampaignsQuerySchema, query);
export const validateListRecipientsQuery = (query: unknown) => validateSchema<ListCampaignRecipientsQuery>(listRecipientsQuerySchema, query);
export const validateCampaignIdParams = (params: unknown) => validateSchema<{ id: string }>(campaignIdParamsSchema, params);
