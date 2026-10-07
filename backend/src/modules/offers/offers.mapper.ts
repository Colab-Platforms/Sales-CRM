import { asRecord, asString } from "../integrations/integrations.common.js";
import type { ActiveOffer, Offer } from "./offers.types.js";

export const EXPIRING_SOON_MS = 48 * 60 * 60 * 1000;

const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};

type TimeParse = { kind: "none" } | { kind: "invalid" } | { kind: "ok"; date: Date };

// Accepts ISO strings and epoch numbers (seconds or milliseconds). A value that is present but unreadable is "invalid",
// which the active check treats as NOT active rather than guessing.
function parseTime(value: unknown): TimeParse {
  if (value === null || value === undefined || value === "") return { kind: "none" };
  let date: Date;
  if (typeof value === "number") date = new Date(value < 1e11 ? value * 1000 : value);
  else if (typeof value === "string") date = /^\d+$/.test(value.trim()) ? new Date(Number(value) < 1e11 ? Number(value) * 1000 : Number(value)) : new Date(value);
  else return { kind: "invalid" };
  return Number.isNaN(date.getTime()) ? { kind: "invalid" } : { kind: "ok", date };
}

/** The list endpoint's body may be the array itself or wrapped; anything else is an error, never an empty list. */
export function extractRules(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const b = asRecord(body);
  const data = b.data;
  if (Array.isArray(data)) return data;
  for (const holder of [b, asRecord(data)]) {
    for (const key of ["discounts", "items", "results", "list"]) if (Array.isArray(holder[key])) return holder[key] as unknown[];
  }
  throw new Error("Fastrr returned the discount list in an unexpected shape");
}

/** One fastrr_rule -> Offer. Only fields present in the rule are filled. */
export function mapRule(raw: unknown): (Offer & { startInvalid: boolean; endInvalid: boolean }) | null {
  const r = asRecord(raw);
  if (Object.keys(r).length === 0) return null;
  const discountConfig = asRecord(asRecord(r.couponConfig).discountConfig);
  const validity = asRecord(r.discountValidity);
  const criteria = asRecord(r.discountCriteria);
  const method = asRecord(r.discountMethod);

  const type = asString(r.discountType);
  const percentage = num(discountConfig.discountPercentage);
  const flat = num(discountConfig.discountFlat);
  const value = type?.toLowerCase() === "percentage" ? percentage : type?.toLowerCase() === "flat" ? flat : (percentage ?? flat);

  const start = parseTime(validity.startTime);
  const end = parseTime(validity.endTime);

  return {
    id: asString(r.id) ?? asString(r._id),
    couponCode: asString(r.couponCode),
    discountType: type,
    discountValue: value,
    automaticDiscount: typeof method.automaticDiscount === "boolean" ? method.automaticDiscount : null,
    startTime: start.kind === "ok" ? start.date.toISOString() : null,
    endTime: end.kind === "ok" ? end.date.toISOString() : null,
    active: r.active === true,
    minCartTotal: num(criteria.minCartTotal),
    minQtyProduct: num(criteria.minQtyProduct),
    productFilter: criteria.productFilter ?? null,
    startInvalid: start.kind === "invalid",
    endInvalid: end.kind === "invalid",
  };
}

/** Active = enabled AND now >= startTime AND (no endTime OR now <= endTime). Evaluated on the caller-supplied (server) clock. */
export function isActive(rule: { active: boolean; startTime: string | null; endTime: string | null; startInvalid?: boolean; endInvalid?: boolean }, now: Date): boolean {
  if (!rule.active) return false;
  if (rule.startInvalid || rule.endInvalid) return false;
  if (rule.startTime && now.getTime() < new Date(rule.startTime).getTime()) return false;
  if (rule.endTime && now.getTime() > new Date(rule.endTime).getTime()) return false;
  return true;
}

export function toActiveOffers(body: unknown, now: Date): ActiveOffer[] {
  const out: ActiveOffer[] = [];
  for (const raw of extractRules(body)) {
    const rule = mapRule(raw);
    if (!rule || !isActive(rule, now)) continue;
    const { startInvalid: _s, endInvalid: _e, ...offer } = rule;
    const expiringSoon = offer.endTime !== null && new Date(offer.endTime).getTime() - now.getTime() <= EXPIRING_SOON_MS;
    out.push({ ...offer, expiringSoon });
  }
  // Soonest-expiring first, no-expiry last: what a telecaller most needs to know about.
  return out.sort((a, b) => (a.endTime ?? "9999").localeCompare(b.endTime ?? "9999"));
}
