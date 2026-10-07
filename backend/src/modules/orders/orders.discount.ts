import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { fromCents } from "../shopify/shopify.money.js";

// The single authority for the order-level "Custom Discount" percentage. Whole-integer arithmetic only: the percentage
// is held in hundredths of a percent (7.5% -> 750) and the discount in cents, so there is no floating-point drift and
// the rounding rule is exactly one: half-up on the cent. The frontend mirrors this for preview only; what the order,
// the Cashfree link and the messages use is always this function's result.
const PERCENT_PATTERN = /^\d+(\.\d{1,2})?$/;

export interface PercentDiscount {
  /** Normalised, e.g. "7.00". */
  percent: string;
  discountCents: number;
  finalCents: number;
}

/** `baseCents` is the amount the percentage applies to (items after any line discounts; shipping is never discounted). */
export function computePercentDiscount(baseCents: number, rawPercent: string): PercentDiscount {
  const text = String(rawPercent).trim();
  if (text.startsWith("-")) throw new ApiError("Discount cannot be negative", STATUS_CODES.BAD_REQUEST);
  if (!PERCENT_PATTERN.test(text)) throw new ApiError("Enter a valid discount percentage", STATUS_CODES.BAD_REQUEST);

  const hundredths = Math.round(Number(text) * 100);
  if (hundredths > 10_000) throw new ApiError("Discount cannot exceed 100%", STATUS_CODES.BAD_REQUEST);

  const discountCents = Math.round((baseCents * hundredths) / 10_000);
  return { percent: (hundredths / 100).toFixed(2), discountCents, finalCents: baseCents - discountCents };
}

export const formatCents = fromCents;
