// Sanitized, CRM-facing shape of one Fastrr Checkout promotional discount ("fastrr_rule"). Only fields Fastrr actually
// returned are filled; everything else is null - never a default or a guess.
export type FastrrDiscountType = "percentage" | "flat" | "freebie";

export interface Offer {
  id: string | null;
  /** null for an automatic discount that has no code. */
  couponCode: string | null;
  /** As Fastrr reports it (normally percentage | flat | freebie); null when absent. */
  discountType: string | null;
  /** Percentage (e.g. 25) or flat amount, from couponConfig.discountConfig. null for a freebie or when absent. */
  discountValue: number | null;
  /** true = applied automatically, false = needs the coupon code, null = Fastrr did not say. */
  automaticDiscount: boolean | null;
  /** ISO-8601, or null when Fastrr gave none. */
  startTime: string | null;
  /** null = no expiry. */
  endTime: string | null;
  active: boolean;
  minCartTotal: number | null;
  minQtyProduct: number | null;
  /** discountCriteria.productFilter exactly as Fastrr returned it. */
  productFilter: unknown | null;
}

/** An offer plus presentation-only state computed on the server's clock. */
export interface ActiveOffer extends Offer {
  /** CRM presentation hint only (end time within 48h) - never changes Fastrr's own status. */
  expiringSoon: boolean;
}

export interface ActiveOffersResult {
  offers: ActiveOffer[];
  /** ISO time the underlying Fastrr list was fetched (cache age). */
  fetchedAt: string;
}
