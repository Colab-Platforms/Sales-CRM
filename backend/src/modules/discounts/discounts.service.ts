import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { computePercentDiscount } from "../orders/orders.discount.js";
import { offersService } from "../offers/offers.controller.js";
import type { ActiveOffer, ActiveOffersResult } from "../offers/offers.types.js";
import { loadDefaultDiscount } from "./discounts.config.js";

// Discounts for Create Order and Prepaid Upgrade. ONE place decides what discount an operation gets: the browser sends only a
// custom type + value, or a Fastrr coupon CODE; this resolves it against the real base amount and (for a coupon) the live, active
// Fastrr offers. The CRM keeps no coupon list of its own. A discount is a single choice that REPLACES the default - never added on top.
export type DiscountFlow = "ORDER" | "UPGRADE";
export type DiscountType = "FIXED" | "PERCENT";

export interface DiscountSelection {
  /** Explicitly no discount (the telecaller removed the default). */
  none?: boolean;
  /** A Fastrr coupon code. Its type/value come from Fastrr, never from the request. */
  couponCode?: string;
  type?: DiscountType;
  value?: string | number;
}

export interface ResolvedDiscount {
  source: "NONE" | "FASTRR" | "CUSTOM";
  type: DiscountType | null;
  /** The coupon's / typed value, normalised (e.g. "100.00" or "10.00"). */
  value: string | null;
  amountCents: number;
  /** Fastrr's reference for the offer (its id). */
  couponId: string | null;
  couponCode: string | null;
  couponSource: "FASTRR" | null;
  /** A custom discount that is exactly the configured default. */
  wasDefault: boolean;
}

export const NO_DISCOUNT: ResolvedDiscount = { source: "NONE", type: null, value: null, amountCents: 0, couponId: null, couponCode: null, couponSource: null, wasDefault: false };

const MONEY = /^\d+(\.\d{1,2})?$/;
const bad = (m: string) => new ApiError(m, STATUS_CODES.BAD_REQUEST);

/** Pure: the discount in cents for a type + value against `baseCents`. Throws the user-facing validation messages. */
export function computeDiscountCents(baseCents: number, type: DiscountType, rawValue: string | number): { cents: number; value: string } {
  if (type === "PERCENT") {
    const r = computePercentDiscount(baseCents, String(rawValue)); // negative / >100 / non-numeric messages
    return { cents: r.discountCents, value: r.percent };
  }
  const text = String(rawValue).trim();
  if (text.startsWith("-")) throw bad("Discount cannot be negative");
  if (!MONEY.test(text)) throw bad("Enter a valid discount amount");
  const cents = Math.round(Number(text) * 100);
  if (cents > baseCents) throw bad("Discount cannot exceed the amount it applies to");
  return { cents, value: (cents / 100).toFixed(2) };
}

export interface FastrrCouponOption {
  code: string;
  /** Fastrr's own id for the offer. */
  id: string | null;
  type: DiscountType;
  value: string;
  minCartTotal: number | null;
}

interface OffersSource {
  getActiveOffers(): Promise<ActiveOffersResult>;
}

// A product filter we cannot evaluate (no line items are known here) makes an offer unverifiable, so it is not offered.
const hasProductFilter = (f: unknown) => f !== null && f !== undefined && !(Array.isArray(f) && f.length === 0) && !(typeof f === "object" && Object.keys(f as object).length === 0);

/** An active Fastrr offer a telecaller can apply by code: it has a code, is not automatic, is flat/percentage, has no unverifiable filter. */
export function toCouponOption(o: ActiveOffer): FastrrCouponOption | null {
  const t = o.discountType?.toLowerCase();
  if (!o.couponCode || o.automaticDiscount === true || o.discountValue === null || !(o.discountValue > 0)) return null;
  if (t !== "flat" && t !== "percentage") return null;
  if (hasProductFilter(o.productFilter)) return null;
  return { code: o.couponCode, id: o.id, type: t === "flat" ? "FIXED" : "PERCENT", value: String(o.discountValue), minCartTotal: o.minCartTotal };
}

// Test seam: the Fastrr source used when a caller does not pass one (Orders / Prepaid Upgrade build DiscountsService themselves).
let defaultSource: OffersSource = offersService;
export function setDefaultOffersSource(source: OffersSource | null): void {
  defaultSource = source ?? offersService;
}

class DiscountsService {
  constructor(
    _db: DbClient = prisma, // accepted so callers can pass their transaction; Fastrr is the only source now
    private readonly offers: OffersSource | undefined = undefined,
  ) {}

  private get source(): OffersSource {
    return this.offers ?? defaultSource;
  }

  /** What the UI offers: the configured default (custom) discount and the live Fastrr coupons. Never a CRM-defined coupon list. */
  async options(_flow: DiscountFlow) {
    const defaultDiscount = loadDefaultDiscount();
    try {
      const { offers } = await this.source.getActiveOffers();
      const coupons = offers.map(toCouponOption).filter((c): c is FastrrCouponOption => c !== null);
      return { defaultDiscount, fastrr: { available: true as boolean, coupons, reason: null as string | null } };
    } catch (error: any) {
      // Not configured or unreachable: say so. Never substitute made-up coupons.
      return { defaultDiscount, fastrr: { available: false as boolean, coupons: [] as FastrrCouponOption[], reason: (error?.message as string) ?? "Fastrr coupons are unavailable" } };
    }
  }

  /** Resolves a selection against the real base (and, for a coupon, the live Fastrr offer). `baseCents` is what the discount may apply to. */
  async resolve(_flow: DiscountFlow, selection: DiscountSelection | undefined | null, baseCents: number): Promise<ResolvedDiscount> {
    if (!selection || selection.none) return NO_DISCOUNT;

    if (selection.couponCode !== undefined) {
      // A coupon's value is Fastrr's: a request that names a coupon but carries its own numbers is rejected, never trusted.
      if (selection.type !== undefined || selection.value !== undefined) throw bad("Send either a Fastrr coupon or a custom discount, not both");
      const code = selection.couponCode.trim();
      if (!code) throw bad("Choose a Fastrr coupon");
      let active: ActiveOffer[];
      try {
        active = (await this.source.getActiveOffers()).offers;
      } catch {
        throw new ApiError("Fastrr coupons are unavailable right now, so this coupon cannot be validated.", STATUS_CODES.SERVICE_UNAVAILABLE);
      }
      const offer = active.find((o) => o.couponCode === code);
      if (!offer) throw bad("This coupon is not an active Fastrr coupon");
      const option = toCouponOption(offer);
      if (!option) throw bad("This coupon can not be applied here");
      if (option.minCartTotal !== null && baseCents < Math.round(option.minCartTotal * 100)) throw bad(`This coupon needs a minimum order of ${option.minCartTotal}`);
      const { cents, value } = computeDiscountCents(baseCents, option.type, option.value);
      if (cents === 0) throw bad("This coupon gives no discount on this amount");
      return { source: "FASTRR", type: option.type, value, amountCents: cents, couponId: option.id, couponCode: option.code, couponSource: "FASTRR", wasDefault: false };
    }

    if (!selection.type) throw bad("Choose a discount type");
    if (selection.value === undefined || String(selection.value).trim() === "") throw bad("Enter a discount");
    const { cents, value } = computeDiscountCents(baseCents, selection.type, selection.value);
    if (cents === 0) return NO_DISCOUNT;
    const def = loadDefaultDiscount();
    const wasDefault = def.type === selection.type && Number(def.value) === Number(value);
    return { source: "CUSTOM", type: selection.type, value, amountCents: cents, couponId: null, couponCode: null, couponSource: null, wasDefault };
  }
}

export default DiscountsService;
