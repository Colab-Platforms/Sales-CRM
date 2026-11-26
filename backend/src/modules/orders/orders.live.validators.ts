import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { OrderSource, OrderStatus, PaymentStatus } from "../../../generated/prisma/enums.js";
import { NO_PAYMENT } from "./orders.types.js";
import type { LiveOrderHistoryQuery, LiveOrdersQuery } from "./orders.live.types.js";

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

// A list filter arrives as one query value: "COD,PREPAID" (or a single value, as older callers send). Empty entries are dropped.
const list = <T extends z.ZodType>(item: T) =>
  z.preprocess((value) => {
    if (value === "" || value === undefined || value === null) return undefined;
    const parts = (Array.isArray(value) ? value : String(value).split(",")).map((v) => String(v).trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }, z.array(item).max(30, "Too many values").optional());
const rupees = (field: string) => optional(z.coerce.number({ error: `${field} must be a number` }).min(0, `${field} must not be negative`).max(100_000_000, `${field} is too large`));

const liveOrdersQuerySchema = z
  .object({
    after: optional(z.string().trim().max(500, "after must be a valid cursor")),
    // 25-50 per the requirement ("Initial page should load only a small page") - never the whole
    // history, and never large enough to make the per-page CRM-lookup join expensive.
    first: z.coerce.number({ error: "first must be a number" }).int().min(1).max(100).default(25),
    search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
    dateFrom: optional(z.iso.datetime({ offset: true, error: "dateFrom must be an ISO date-time" }).transform((v) => new Date(v))),
    dateTo: optional(z.iso.datetime({ offset: true, error: "dateTo must be an ISO date-time" }).transform((v) => new Date(v))),
    status: list(z.enum(OrderStatus, { error: "Invalid order status" })),
    paymentStatus: list(z.enum([...Object.values(PaymentStatus), NO_PAYMENT], { error: "Invalid payment status" })),
    paymentMode: list(z.enum(["COD", "PREPAID"], { error: "Invalid payment mode" })),
    source: list(z.enum(OrderSource, { error: "Invalid order source" })),
    salespersonId: list(z.uuid({ error: "Invalid salesperson id" })),
    leadSourceId: list(z.uuid({ error: "Invalid lead source id" })),
    fulfillment: list(z.string().regex(/^[A-Z_]{2,40}$/, "Invalid fulfilment status")),
    // Shopify tags cannot contain commas, so a comma list is unambiguous.
    tags: list(z.string().trim().min(1).max(255, "Tag is too long")),
    totalMin: rupees("totalMin"),
    totalMax: rupees("totalMax"),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
    error: "dateFrom must not be after dateTo",
  })
  .refine((q) => q.totalMin === undefined || q.totalMax === undefined || q.totalMin <= q.totalMax, {
    error: "totalMin must not be greater than totalMax",
  });

export const validateLiveOrdersQuery = (query: unknown) => validateSchema<LiveOrdersQuery>(liveOrdersQuerySchema, query);

export type LiveOrdersExportRequest = { ids: string[] } | { filters: Omit<LiveOrdersQuery, "after" | "first"> };

// A CRM order id, or "shopify:<id>" for an order the CRM has not synced: the two forms the list's rows carry.
const selectedOrderId = z.union([z.uuid(), z.string().regex(/^shopify:\d{1,20}$/)], { error: "Invalid order id" });
const selectionSchema = z.array(selectedOrderId, { error: "ids must be a list" }).min(1, "Select at least one order to download").max(1000, "Select at most 1000 orders");

/** Exactly one of {ids} (the ticked orders) or {filters} (the list's own query values, as strings). Pagination values are ignored. */
export function validateLiveOrdersExport(body: unknown): { error: { message: string }; value?: undefined } | { error: null; value: LiveOrdersExportRequest } {
  const { ids, filters, ...rest } = (body ?? {}) as { ids?: unknown; filters?: unknown };
  if (Object.keys(rest).length || (ids === undefined) === (filters === undefined)) return { error: { message: "Send either the selected order ids or the filters" } };
  if (ids !== undefined) {
    const parsed = selectionSchema.safeParse(ids);
    return parsed.success ? { error: null, value: { ids: parsed.data } } : { error: { message: parsed.error.issues[0]!.message } };
  }
  // an unknown name must not be dropped silently: that would download more than the screen shows
  const known = new Set(Object.keys(liveOrdersQuerySchema.shape));
  if (typeof filters !== "object" || filters === null || Array.isArray(filters) || Object.keys(filters).some((k) => !known.has(k))) return { error: { message: "Invalid filters" } };
  const checked = validateLiveOrdersQuery(filters);
  if (checked.error) return { error: { message: checked.error.message } };
  const { after: _after, first: _first, ...value } = checked.value!;
  return { error: null, value: { filters: value } };
}

const liveOrderHistoryQuerySchema = z.object({
  after: optional(z.string().trim().max(500, "after must be a valid cursor")),
  first: z.coerce.number({ error: "first must be a number" }).int().min(1).max(25).default(10),
});

export const validateLiveOrderHistoryQuery = (query: unknown) => validateSchema<LiveOrderHistoryQuery>(liveOrderHistoryQuerySchema, query);
