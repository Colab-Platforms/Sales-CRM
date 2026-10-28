import { z } from "zod";
import { RANGE_KINDS } from "./orders.dashboard.range.js";
import { INTERVALS, type Interval } from "./orders.dashboard.insights.js";
import { validateSchema } from "@/utils/validate.js";
import { MAX_PAGE_SIZE, METRICS, type DashboardFilters } from "./orders.dashboard.service.js";
import { ORDER_STATUSES, PAYMENT_MODES } from "./orders.dashboard.telecaller.js";
import { ABANDONED_METRICS, MAX_ABANDONED_PAGE_SIZE, type AbandonedFilters } from "./abandoned.dashboard.service.js";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());

const filterSchema = z.object({
  range: opt(z.enum(RANGE_KINDS, { error: "Unknown date range" })),
  from: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "From must be YYYY-MM-DD" })),
  to: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "To must be YYYY-MM-DD" })),
  section: opt(z.enum(["ALL", "WEBSITE", "TELECALLER"], { error: "Unknown section" })),
  source: opt(z.enum(["SHOPIFY", "WEBSITE", "API", "SALESPERSON"], { error: "Unknown source" })),
  search: opt(z.string().trim().max(100)),
  paymentStatus: opt(z.enum(["SUCCESS", "PENDING", "PROCESSING", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED", "NO_PAYMENT"], { error: "Unknown payment status" })),
  metric: opt(z.enum(METRICS, { error: "Unknown summary card" })),
  scope: opt(z.enum(["WEBSITE"], { error: "Unknown dashboard scope" })),
  fulfilment: opt(z.enum(["UNFULFILLED", "FULFILLED", "CANCELLED", "RETURNED"], { error: "Unknown fulfilment status" })),
});

const listSchema = filterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
});

export const validateFilters = (query: unknown) => validateSchema<DashboardFilters>(filterSchema as never, query);
export const validateList = (query: unknown) => validateSchema<DashboardFilters & { page: number; pageSize: number }>(listSchema as never, query);

// ---- Abandoned Checkouts dashboard (same date-range fields; its own cards)
const abandonedFilterSchema = z.object({
  range: opt(z.enum(RANGE_KINDS, { error: "Unknown date range" })),
  from: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "From must be YYYY-MM-DD" })),
  to: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "To must be YYYY-MM-DD" })),
  metric: opt(z.enum(ABANDONED_METRICS as unknown as [string, ...string[]], { error: "Unknown summary card" })),
  search: opt(z.string().trim().max(100)),
});
const abandonedListSchema = abandonedFilterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_ABANDONED_PAGE_SIZE).default(25),
});
export const validateAbandonedFilters = (query: unknown) => validateSchema<AbandonedFilters>(abandonedFilterSchema as never, query);
export const validateAbandonedList = (query: unknown) => validateSchema<AbandonedFilters & { page: number; pageSize: number }>(abandonedListSchema as never, query);

const chartSchema = z.object({
  range: opt(z.enum(RANGE_KINDS, { error: "Unknown date range" })),
  from: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "From must be YYYY-MM-DD" })),
  to: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "To must be YYYY-MM-DD" })),
  interval: z.enum(INTERVALS, { error: "interval must be daily, weekly or monthly" }).default("daily"),
});
export const validateChart = (query: unknown) => validateSchema<{ range?: (typeof RANGE_KINDS)[number]; from?: string; to?: string; interval: Interval }>(chartSchema as never, query);

const telecallerSchema = z.object({
  range: opt(z.enum(RANGE_KINDS, { error: "Unknown date range" })),
  from: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "From must be YYYY-MM-DD" })),
  to: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "To must be YYYY-MM-DD" })),
  salespersonId: opt(z.uuid({ error: "Invalid salesperson" })),
  paymentMode: opt(z.enum(PAYMENT_MODES as [string, ...string[]], { error: "Unknown payment filter" })),
  orderStatus: opt(z.enum(ORDER_STATUSES as unknown as [string, ...string[]], { error: "Unknown order status" })),
});
export interface TelecallerFilters { range?: (typeof RANGE_KINDS)[number]; from?: string; to?: string; salespersonId?: string; paymentMode?: "ALL" | "COD" | "PREPAID"; orderStatus?: string }
export const validateTelecaller = (query: unknown) => validateSchema<TelecallerFilters>(telecallerSchema as never, query);
