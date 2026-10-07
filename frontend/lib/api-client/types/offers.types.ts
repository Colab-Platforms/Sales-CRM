// Sanitized Fastrr Checkout offer as served by GET /offers/active (see backend modules/offers). Only fields Fastrr
// actually returned are non-null.
export interface ActiveOffer {
  id: string | null;
  /** null for an automatic discount that has no code. */
  couponCode: string | null;
  /** As Fastrr reports it: normally "percentage" | "flat" | "freebie". */
  discountType: string | null;
  /** Percentage (25) or flat amount; null for a freebie or when Fastrr gave none. */
  discountValue: number | null;
  /** true = applied automatically, false = needs the coupon code. */
  automaticDiscount: boolean | null;
  startTime: string | null;
  /** null = no expiry. */
  endTime: string | null;
  active: boolean;
  minCartTotal: number | null;
  minQtyProduct: number | null;
  productFilter: unknown | null;
  /** Server-computed presentation hint: ends within 48 hours. */
  expiringSoon: boolean;
}

export interface ActiveOffersResult {
  offers: ActiveOffer[];
  fetchedAt: string;
}
