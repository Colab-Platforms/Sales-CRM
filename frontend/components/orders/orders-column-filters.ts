// Pure state for the Orders table's column filters (no React, no I/O) so the rules are testable on their own.
// Filters live in the URL (so refresh, Back/Forward and a shared link keep them): each is a comma list ("COD,PREPAID"),
// different filters are AND-ed by the backend and values inside one filter are OR-ed. Dates are kept as local calendar days
// (YYYY-MM-DD) and a preset is stored by name so "Last 7 days" stays relative after a refresh.
import { ORDER_SOURCE_ORDER, ORDER_STATUS_ORDER, PAYMENT_STATUS_ORDER } from "@/lib/order-status";
import type { OrderSource, OrderStatus, PaymentStatusFilter } from "@/lib/api-client/types/orders.types";

export type PaymentModeFilter = "COD" | "PREPAID";
export const FULFILLMENT_VALUES = ["UNFULFILLED", "PARTIALLY_FULFILLED", "FULFILLED"] as const;
export const DATE_PRESETS = ["today", "yesterday", "7d", "30d", "month"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];
export const DATE_PRESET_LABELS: Record<DatePreset, string> = { today: "Today", yesterday: "Yesterday", "7d": "Last 7 days", "30d": "Last 30 days", month: "This month" };

export const TOTAL_PRESETS = [
  { key: "0-500", label: "₹0–₹500", min: 0, max: 500 },
  { key: "500-1000", label: "₹500–₹1,000", min: 500, max: 1000 },
  { key: "1000-2500", label: "₹1,000–₹2,500", min: 1000, max: 2500 },
  { key: "2500+", label: "₹2,500+", min: 2500, max: undefined },
] as const;

export interface ColumnFilters {
  status: OrderStatus[];
  fulfillment: string[];
  paymentMode: PaymentModeFilter[];
  paymentStatus: PaymentStatusFilter[];
  source: OrderSource[];
  salespersonId: string[];
  leadSourceId: string[];
  /** Exact order tags (Shopify tags and "CRM Confirmed by …"); any of them (OR). */
  tags: string[];
  totalMin?: string;
  totalMax?: string;
  datePreset?: DatePreset;
  dateFrom?: string;
  dateTo?: string;
}

export const EMPTY_FILTERS: ColumnFilters = { status: [], fulfillment: [], paymentMode: [], paymentStatus: [], source: [], salespersonId: [], leadSourceId: [], tags: [] };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A tag: 1-255 characters, no commas (the URL list separator; Shopify tags cannot contain one anyway).
const TAG_PATTERN = /^[^,]{1,255}$/;
const NUMBER_PATTERN = /^\d+(\.\d{1,2})?$/;
const PAYMENT_STATUS_VALUES: readonly string[] = [...PAYMENT_STATUS_ORDER, "NONE"];

/** The viewer's local calendar day as YYYY-MM-DD (never toISOString(), which is UTC and shifts the day near midnight). */
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function presetRange(preset: DatePreset, now: Date = new Date()): { dateFrom: string; dateTo: string } {
  const day = (offset: number) => localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  switch (preset) {
    case "today":
      return { dateFrom: day(0), dateTo: day(0) };
    case "yesterday":
      return { dateFrom: day(-1), dateTo: day(-1) };
    case "7d":
      return { dateFrom: day(-6), dateTo: day(0) };
    case "30d":
      return { dateFrom: day(-29), dateTo: day(0) };
    case "month":
      return { dateFrom: localDay(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: day(0) };
  }
}

function list<T extends string>(params: URLSearchParams, key: string, allowed: readonly string[] | RegExp): T[] {
  const raw = params.get(key);
  if (!raw) return [];
  const ok = (v: string) => (allowed instanceof RegExp ? allowed.test(v) : allowed.includes(v));
  return [...new Set(raw.split(",").map((v) => v.trim()).filter(ok))] as T[];
}

export function parseColumnFilters(params: URLSearchParams, now: Date = new Date()): ColumnFilters {
  const number = (key: string) => {
    const v = params.get(key);
    return v && NUMBER_PATTERN.test(v) ? v : undefined;
  };
  const day = (key: string) => {
    const v = params.get(key);
    return v && DATE_PATTERN.test(v) ? v : undefined;
  };
  const presetValue = params.get("datePreset");
  const datePreset = (DATE_PRESETS as readonly string[]).includes(presetValue ?? "") ? (presetValue as DatePreset) : undefined;
  const range = datePreset ? presetRange(datePreset, now) : { dateFrom: day("dateFrom"), dateTo: day("dateTo") };
  return {
    status: list<OrderStatus>(params, "status", ORDER_STATUS_ORDER),
    fulfillment: list<string>(params, "fulfillment", FULFILLMENT_VALUES),
    paymentMode: list<PaymentModeFilter>(params, "paymentMode", ["COD", "PREPAID"]),
    paymentStatus: list<PaymentStatusFilter>(params, "paymentStatus", PAYMENT_STATUS_VALUES),
    source: list<OrderSource>(params, "source", ORDER_SOURCE_ORDER),
    salespersonId: list<string>(params, "salespersonId", UUID_PATTERN),
    leadSourceId: list<string>(params, "leadSourceId", UUID_PATTERN),
    tags: list<string>(params, "tags", TAG_PATTERN),
    totalMin: number("totalMin"),
    totalMax: number("totalMax"),
    datePreset,
    ...range,
  };
}

/** URL patch for one or more filters: arrays become comma lists, empty -> removed. Setting a preset clears explicit dates (and vice versa). */
export function filtersToParams(patch: Partial<ColumnFilters>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (Array.isArray(value)) out[key] = value.length ? value.join(",") : undefined;
    else out[key] = value === undefined || value === "" ? undefined : String(value);
  }
  if ("datePreset" in patch && patch.datePreset) {
    out.dateFrom = undefined;
    out.dateTo = undefined;
  }
  if (("dateFrom" in patch || "dateTo" in patch) && !("datePreset" in patch)) out.datePreset = undefined;
  return out;
}

export type FilterColumn = "payment" | "source" | "status" | "salesperson" | "leadSource" | "date" | "total" | "tags";

export function isColumnActive(f: ColumnFilters, column: FilterColumn): boolean {
  switch (column) {
    case "payment":
      return f.paymentMode.length > 0 || f.paymentStatus.length > 0;
    case "source":
      return f.source.length > 0;
    case "status":
      return f.status.length > 0 || f.fulfillment.length > 0;
    case "salesperson":
      return f.salespersonId.length > 0;
    case "leadSource":
      return f.leadSourceId.length > 0;
    case "date":
      return Boolean(f.datePreset || f.dateFrom || f.dateTo);
    case "total":
      return f.totalMin !== undefined || f.totalMax !== undefined;
    case "tags":
      return f.tags.length > 0;
  }
}

export const FILTER_COLUMNS: FilterColumn[] = ["payment", "source", "status", "salesperson", "leadSource", "date", "total", "tags"];
export const hasActiveColumnFilters = (f: ColumnFilters) => FILTER_COLUMNS.some((c) => isColumnActive(f, c));

/** Which total preset (if any) the current min/max equals - used to tick the radio. */
export function activeTotalPreset(f: Pick<ColumnFilters, "totalMin" | "totalMax">): string | null {
  const p = TOTAL_PRESETS.find((t) => String(t.min) === f.totalMin && (t.max === undefined ? f.totalMax === undefined : String(t.max) === f.totalMax));
  return p ? p.key : null;
}

/** The query params every filter contributes to the API (the backend ANDs them). Dates become the viewer's local day boundaries. */
export function filtersToApi(f: ColumnFilters): Record<string, string | string[] | undefined> {
  const csv = (v: string[]) => (v.length ? v : undefined);
  return { status: csv(f.status), fulfillment: csv(f.fulfillment), paymentMode: csv(f.paymentMode), paymentStatus: csv(f.paymentStatus), source: csv(f.source), salespersonId: csv(f.salespersonId), leadSourceId: csv(f.leadSourceId), tags: csv(f.tags), totalMin: f.totalMin, totalMax: f.totalMax };
}
