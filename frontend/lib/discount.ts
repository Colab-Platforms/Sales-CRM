// The discount choice shared by Create Order and Prepaid Upgrade. PREVIEW ONLY: the browser sends the choice (a Fastrr coupon CODE,
// or a custom type + value, or "none") and the backend validates it against live Fastrr and the real amounts - the numbers here
// just mirror the server's whole-paise rules so the summary is right as you edit. A choice REPLACES any default; it never stacks.
// The CRM has no coupon list of its own: coupons are Fastrr's, the default is a custom discount from configuration.
export type DiscountType = "FIXED" | "PERCENT";

/** A live Fastrr coupon as the backend returns it (value/type are Fastrr's). */
export interface CouponOption {
  code: string;
  id: string | null;
  type: DiscountType;
  value: string;
  minCartTotal: number | null;
}

/** GET /discounts/options */
export interface DiscountOptions {
  defaultDiscount: { type: DiscountType; value: string };
  fastrr: { available: boolean; coupons: CouponOption[]; reason: string | null };
}

export type DiscountChoice =
  | { mode: "NONE" }
  | { mode: "COUPON"; code: string; type: DiscountType; value: string }
  | { mode: "CUSTOM"; type: DiscountType; value: string };

export const NO_DISCOUNT: DiscountChoice = { mode: "NONE" };

export function choiceFromCoupon(c: CouponOption): DiscountChoice {
  return { mode: "COUPON", code: c.code, type: c.type, value: c.value };
}

/** The configured default - a CUSTOM discount (₹50 fixed unless the business changes it), never a coupon. */
export function defaultChoice(options: Pick<DiscountOptions, "defaultDiscount">): DiscountChoice {
  return { mode: "CUSTOM", type: options.defaultDiscount.type, value: options.defaultDiscount.value };
}

export type DiscountPreview = { ok: true; cents: number } | { ok: false; error: string | null };
const DECIMAL = /^\d+(\.\d{1,2})?$/;

/** `strict`: the discount must leave something to pay (Prepaid Upgrade). Otherwise it may reach the whole amount. error === null = nothing typed yet. */
export function previewDiscount(baseCents: number, type: DiscountType, raw: string, strict = false): DiscountPreview {
  const text = raw.trim();
  if (text === "") return { ok: false, error: null };
  if (text.startsWith("-")) return { ok: false, error: "Discount cannot be negative" };
  if (!DECIMAL.test(text)) return { ok: false, error: type === "PERCENT" ? "Enter a valid discount percentage" : "Enter a valid discount amount" };
  const hundredths = Math.round(Number(text) * 100);
  let cents: number;
  if (type === "PERCENT") {
    if (hundredths > 10_000) return { ok: false, error: "Discount cannot exceed 100%" };
    cents = Math.round((baseCents * hundredths) / 10_000);
  } else {
    cents = hundredths;
    if (cents > baseCents) return { ok: false, error: "Discount cannot exceed the amount it applies to" };
  }
  if (strict && cents >= baseCents) return { ok: false, error: "Discount cannot be greater than or equal to the order amount." };
  if (strict && cents <= 0) return { ok: false, error: "Discount must be greater than 0" };
  return { ok: true, cents };
}

/** Discount in cents for a choice (0 when none / not valid yet). */
export function choiceCents(baseCents: number, choice: DiscountChoice, strict = false): number {
  if (choice.mode === "NONE") return 0;
  const p = previewDiscount(baseCents, choice.type, choice.value, strict);
  return p.ok ? p.cents : 0;
}

/** Row label next to "Discount": the coupon code, "Custom", or nothing. */
export function choiceCaption(choice: DiscountChoice): string | null {
  if (choice.mode === "COUPON") return `Fastrr: ${choice.code}`;
  if (choice.mode === "CUSTOM") return "Custom";
  return null;
}

export function choiceSummary(choice: DiscountChoice): string {
  if (choice.mode === "NONE") return "No discount";
  const v = choice.type === "PERCENT" ? `${Number(choice.value)}%` : `₹${Number(choice.value)}`;
  return choice.mode === "COUPON" ? `Fastrr: ${choice.code}` : `Custom ${v}`;
}

/** What goes on the wire: only the choice - never an amount or a total. */
export function toApiDiscount(choice: DiscountChoice): { none: true } | { couponCode: string } | { type: DiscountType; value: string } {
  if (choice.mode === "NONE") return { none: true };
  if (choice.mode === "COUPON") return { couponCode: choice.code };
  return { type: choice.type, value: choice.value.trim() };
}
