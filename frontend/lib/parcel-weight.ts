// Parcel weight vs product weight. The PARCEL weight is what a person enters for the packed shipment: it is the only weight sent to Shiprocket
// (courier availability and shipment creation). A product/SKU weight is informational and only ever shown when it was actually recorded.
// Nothing here defaults, guesses or calculates a weight or a shipping charge - charges are whatever Shiprocket returns.
export type ParcelWeight = { ok: true; kg: number } | { ok: false; error: string | null };

export const WEIGHT_REQUIRED = "Enter parcel weight to check courier availability.";
export const WEIGHT_REQUIRED_SERVER = "Parcel weight is required before checking courier availability.";

/** Parses what was typed. Empty -> not entered yet (error null); 0, negative, non-numeric or absurd values -> a message. */
export function parseParcelWeight(raw: string): ParcelWeight {
  const text = raw.trim();
  if (text === "") return { ok: false, error: null };
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, error: "Parcel weight must be a number (kg)." };
  const kg = Number(text);
  if (kg < 0) return { ok: false, error: "Parcel weight cannot be negative." };
  if (kg === 0) return { ok: false, error: "Parcel weight must be greater than 0." };
  if (kg > 100) return { ok: false, error: "Parcel weight must be 100 kg or less." };
  return { ok: true, kg };
}

/** "0.50 kg", "1.00 kg", "0.125 kg" - for display only; never stored. */
export function formatKg(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // At least two decimals (0.50 kg, 0.62 kg), at most three (0.125 kg).
  const text = n.toFixed(3).replace(/0$/, "");
  return `${text} kg`;
}

/** The recorded weight of one unit of what is being sold (variant first, else the product), or null when nobody recorded one. */
export function unitWeightKg(product: { weightKg?: string | null } | null | undefined, variant: { weightKg?: string | null } | null | undefined): number | null {
  const raw = variant?.weightKg ?? product?.weightKg ?? null;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Quantity x unit weight, only when a unit weight is recorded. An estimate of the PRODUCTS, not of the packed parcel. */
export function lineProductWeightKg(unit: number | null, quantity: number): number | null {
  return unit !== null && Number.isFinite(quantity) && quantity > 0 ? Number((unit * quantity).toFixed(3)) : null;
}

export interface CourierRow {
  name: string;
  /** Shiprocket's own charge for this parcel weight (INR); null when Shiprocket gave none. */
  rate: number | null;
  days: number | null;
}

// ---- Suggesting a parcel weight from product weights --------------------------------------------------------------------
// The product weight is an ESTIMATE of the goods; the parcel weight is the actual packed shipment weight and stays editable. A suggestion is
// made only when EVERY selected product has a recorded weight - a partial total is never presented as the parcel weight.
export interface WeightLine {
  /** Recorded weight of ONE unit (kg), or null when nobody recorded it. */
  unitKg: number | null;
  quantity: number;
}

export interface ProductWeightEstimate {
  /** Sum of quantity x unit weight over the lines whose weight is recorded; null when none is. */
  knownKg: number | null;
  lineCount: number;
  knownCount: number;
  /** Every line has a recorded weight (and at least one line exists): knownKg is the whole estimate. */
  complete: boolean;
}

export function estimateProductWeight(lines: WeightLine[]): ProductWeightEstimate {
  let total = 0;
  let known = 0;
  for (const l of lines) {
    const kg = lineProductWeightKg(l.unitKg, l.quantity);
    if (kg !== null) {
      total += kg;
      known += 1;
    }
  }
  return { knownKg: known > 0 ? Number(total.toFixed(3)) : null, lineCount: lines.length, knownCount: known, complete: lines.length > 0 && known === lines.length };
}

export type ParcelWeightSource = "suggested" | "manual" | "none";

/**
 * The parcel-weight field's value. Anything the operator typed (`manual` !== null, even an empty string) is authoritative and is NEVER
 * overwritten by a recalculation; otherwise the complete product-weight estimate is suggested, otherwise the field stays empty.
 */
export function resolveParcelWeight(manual: string | null, estimate: ProductWeightEstimate): { text: string; source: ParcelWeightSource } {
  if (manual !== null) return { text: manual, source: "manual" };
  if (estimate.complete && estimate.knownKg !== null && estimate.knownKg > 0) return { text: String(estimate.knownKg), source: "suggested" };
  return { text: "", source: "none" };
}

export function weightHint(source: ParcelWeightSource, estimate: ProductWeightEstimate): string {
  if (source === "suggested") return "Suggested from product weights. Adjust for packaging and actual parcel weight.";
  if (source === "none") {
    return estimate.knownCount > 0 && !estimate.complete ? "Some product weights are not recorded. Enter parcel weight manually." : "Parcel weight not available — enter the actual parcel weight.";
  }
  return "Estimated — used only to check courier availability.";
}

/** The courier rows in display order: cheapest first, rows without a charge last. Charges are Shiprocket's, untouched. */
export function sortCouriers<T extends { rate: number | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.rate ?? Number.POSITIVE_INFINITY) - (b.rate ?? Number.POSITIVE_INFINITY));
}

/**
 * The shipment dialog's weight field. Priority: what the operator typed > the parcel weight already recorded on the order (authoritative, never
 * overwritten by a suggestion) > a suggestion from COMPLETE product weights > empty.
 */
export function shipmentDialogWeight(typed: string | null, recorded: string | null, estimate: ProductWeightEstimate): { text: string; source: ParcelWeightSource | "recorded" } {
  if (typed !== null) return { text: typed, source: "manual" };
  if (recorded !== null && recorded !== "") return { text: recorded, source: "recorded" };
  return resolveParcelWeight(null, estimate);
}
