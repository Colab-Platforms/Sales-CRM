import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";

// The one calculation for a Prepaid Upgrade offer. Integer paise/cents only (half-up), so no floating-point money drift.
// The frontend mirrors this for a live preview, but the stored offer - and the amount sent to the payment provider - is
// always this function's result, never a figure supplied by the browser.
export type UpgradeDiscountType = "FIXED" | "PERCENT";

export interface UpgradeAmounts {
  /** Normalised input: "100.00" (rupees) or "10.00" (percent). */
  discountValue: string;
  discountCents: number;
  prepaidCents: number;
}

const DECIMAL = /^\d+(\.\d{1,2})?$/;
const bad = (message: string) => new ApiError(message, STATUS_CODES.BAD_REQUEST);

export function computeUpgradeAmounts(originalCents: number, type: UpgradeDiscountType, rawValue: string | number): UpgradeAmounts {
  const text = String(rawValue).trim();
  if (text.startsWith("-")) throw bad("Discount cannot be negative");
  if (!DECIMAL.test(text)) throw bad("Enter a valid discount");
  const hundredths = Math.round(Number(text) * 100); // rupees->paise for FIXED, percent->hundredths-of-a-percent for PERCENT
  if (hundredths <= 0) throw bad("Discount must be greater than 0");

  let discountCents: number;
  if (type === "FIXED") {
    discountCents = hundredths;
  } else {
    if (hundredths > 10_000) throw bad("Percentage cannot exceed 100");
    discountCents = Math.round((originalCents * hundredths) / 10_000);
    if (discountCents <= 0) throw bad("Discount is too small to apply to this amount");
  }
  if (discountCents >= originalCents) throw bad("Discount cannot be greater than or equal to the order amount.");
  return { discountValue: (hundredths / 100).toFixed(2), discountCents, prepaidCents: originalCents - discountCents };
}
