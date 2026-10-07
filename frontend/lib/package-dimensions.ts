// PRODUCT dimensions (what the catalog records for ONE unit) vs the FINAL PACKED PARCEL dimensions (what is actually sent to Shiprocket).
//
// Dimensions are never added up or averaged across products: the box several products share is not the sum or the mean of their boxes. A
// product's own dimensions are suggested as the parcel only in the one case where they genuinely are the parcel - a single unit of a single
// product. In every other case the packed dimensions are left for the operator to enter, and nothing is requested from Shiprocket until they are.
export interface DimensionsCm {
  length: number;
  breadth: number;
  height: number;
}

export interface UnitDimensionsCm {
  lengthCm: string;
  widthCm: string;
  heightCm: string;
}

/** What the operator typed into the three packed-dimension fields (strings, exactly as typed). */
export interface DimensionDraft {
  length: string;
  breadth: string;
  height: string;
}

export const DIMENSIONS_REQUIRED = "Enter the packed parcel dimensions (cm) to calculate shipping rates.";
export const MAX_DIMENSION_CM = 300;

export const emptyDimensionDraft = (): DimensionDraft => ({ length: "", breadth: "", height: "" });

export type ParcelDimensions = { ok: true; cm: DimensionsCm } | { ok: false; error: string | null };

function parseSide(raw: string, label: string): { ok: true; cm: number } | { ok: false; error: string | null } {
  const text = raw.trim();
  if (text === "") return { ok: false, error: null };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, error: `${label} must be a number (cm).` };
  const cm = Number(text);
  if (cm <= 0) return { ok: false, error: `${label} must be greater than 0.` };
  if (cm > MAX_DIMENSION_CM) return { ok: false, error: `${label} must be ${MAX_DIMENSION_CM} cm or less.` };
  return { ok: true, cm };
}

/** All three sides are required. A missing side -> not ok with no message (nothing typed yet); a bad one -> a message. */
export function parseParcelDimensions(d: DimensionDraft): ParcelDimensions {
  const sides = [parseSide(d.length, "Length"), parseSide(d.breadth, "Breadth"), parseSide(d.height, "Height")] as const;
  const bad = sides.find((s) => !s.ok);
  if (bad && !bad.ok) return { ok: false, error: bad.error };
  const [l, b, h] = sides;
  if (!l.ok || !b.ok || !h.ok) return { ok: false, error: null };
  return { ok: true, cm: { length: l.cm, breadth: b.cm, height: h.cm } };
}

const n = (v: string) => String(Number(v));

/** "20 × 15 × 2 cm" for display. */
export function formatDimensions(d: DimensionsCm | UnitDimensionsCm | null | undefined): string | null {
  if (!d) return null;
  if ("lengthCm" in d) return `${n(d.lengthCm)} × ${n(d.widthCm)} × ${n(d.heightCm)} cm`;
  return `${d.length} × ${d.breadth} × ${d.height} cm`;
}

export interface DimensionLine {
  /** Recorded per-unit dimensions, or null when the catalog has none. */
  unit: UnitDimensionsCm | null;
  quantity: number;
}

/** The product dimensions to show (one per line, when recorded). Informational - never the parcel. */
export const productDimensionsNote = (lines: DimensionLine[]): string | null => {
  const known = lines.filter((l) => l.unit);
  if (known.length === 0) return null;
  return known.map((l) => formatDimensions(l.unit)).join(" · ");
};

/**
 * The packed parcel dimensions that can be suggested safely: exactly one line, exactly one unit, with recorded dimensions. Anything else (several
 * products, more than one unit, unknown dimensions) -> null, and the operator enters the real packed size.
 */
export function suggestPackedDimensions(lines: DimensionLine[]): DimensionsCm | null {
  if (lines.length !== 1) return null;
  const only = lines[0]!;
  if (only.quantity !== 1 || !only.unit) return null;
  const length = Number(only.unit.lengthCm);
  const breadth = Number(only.unit.widthCm);
  const height = Number(only.unit.heightCm);
  return length > 0 && breadth > 0 && height > 0 ? { length, breadth, height } : null;
}

export type DimensionSource = "suggested" | "manual" | "none";

/** Anything the operator typed (`manual` !== null) wins and is never overwritten; otherwise the safe suggestion; otherwise empty. */
export function resolvePackedDimensions(manual: DimensionDraft | null, suggestion: DimensionsCm | null): { draft: DimensionDraft; source: DimensionSource } {
  if (manual) return { draft: manual, source: "manual" };
  if (suggestion) return { draft: { length: String(suggestion.length), breadth: String(suggestion.breadth), height: String(suggestion.height) }, source: "suggested" };
  return { draft: emptyDimensionDraft(), source: "none" };
}

export function dimensionsHint(source: DimensionSource, lines: DimensionLine[]): string {
  if (source === "suggested") return "Suggested from the product dimensions (one unit). Adjust to the packed parcel size.";
  if (source === "manual") return "Final packed parcel dimensions — sent to Shiprocket as entered.";
  if (lines.length > 1) return "Dimensions are not added up across products — enter the final packed parcel size.";
  if (lines.length === 1 && lines[0]!.quantity > 1) return "More than one unit is packed together — enter the final packed parcel size.";
  return "Product dimensions not recorded — enter the final packed parcel size.";
}

/** Everything a rate request needs, or the name of what is still missing. Pure, so the "when do we call Shiprocket" rule is testable. */
export interface RateInputs {
  pincode: string;
  cod: boolean;
  weightKg: number;
  /** The packed parcel dimensions when the operator has them; null = none entered, so Shiprocket is asked about the weight alone. */
  dims: DimensionsCm | null;
  /** Goods value in INR (subtotal after discount), sent to Shiprocket as the declared value. */
  value: number;
}

export function rateInputsOrMissing(input: {
  pincodeValid: boolean;
  pincode: string;
  cod: boolean;
  weight: { ok: true; kg: number } | { ok: false };
  dims: ParcelDimensions;
  /** True when none of the three dimension fields has anything typed/suggested (then rates are requested for the weight alone). */
  dimsEmpty?: boolean;
  value: number;
}): { ok: true; inputs: RateInputs } | { ok: false; missing: "pincode" | "weight" | "dimensions" | "value" } {
  if (!input.pincodeValid) return { ok: false, missing: "pincode" };
  if (!input.weight.ok) return { ok: false, missing: "weight" };
  // Half-typed or invalid dimensions wait for the operator; no dimensions at all is fine - Shiprocket then prices the entered weight.
  if (!input.dims.ok && !input.dimsEmpty) return { ok: false, missing: "dimensions" };
  if (!(input.value > 0)) return { ok: false, missing: "value" };
  return { ok: true, inputs: { pincode: input.pincode, cod: input.cod, weightKg: input.weight.kg, dims: input.dims.ok ? input.dims.cm : null, value: input.value } };
}

/** One string identifying a rate request: results are valid only for the exact inputs they were requested with. */
export const rateKey = (i: RateInputs): string => [i.pincode, i.cod ? "cod" : "prepaid", i.weightKg, i.dims?.length ?? "-", i.dims?.breadth ?? "-", i.dims?.height ?? "-", i.value].join("|");

/** The goods value of an order (INR): subtotal minus discount - what Shiprocket is told as the declared value. Shipping is not goods. */
export const goodsValue = (order: { subtotal: string; discountAmount: string }): number => Math.max(Number(order.subtotal) - Number(order.discountAmount), 0);

/** True when all three dimension fields are blank. */
export const isDimensionDraftEmpty = (d: DimensionDraft): boolean => d.length.trim() === "" && d.breadth.trim() === "" && d.height.trim() === "";
