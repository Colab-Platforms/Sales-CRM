// The parcel sent with an automatic Shiprocket registration, derived from the PRODUCT-LEVEL measurements already in the CRM catalogue (Product / ProductVariant: weightKg, lengthCm, widthCm = breadth, heightCm;
// filled from Shopify-linked products and the Shiprocket catalogue import, see products.catalog-import.ts).
//
//  - Weight = the sum of (unit weight x quantity). It is the entered weight, never a volumetric weight.
//  - Dimensions = the LARGEST length, the LARGEST breadth and the LARGEST height among the products in the order (never added together). It is an initial package size.
//  - A missing, blank, zero or negative measurement is "not recorded": nothing is guessed or defaulted. The order is not sent, and the exact SKU and fields are reported.
//  - A weight recorded on the order itself (the packed-parcel weight typed at Create Order) is a person's explicit entry and is used for the weight in place of the product sum.
// Pure: no I/O.

export interface MeasuredItem {
  quantity: number;
  skuSnapshot: string | null;
  productNameSnapshot: string;
  variantNameSnapshot: string | null;
  /** The variant's own measurements when the line has a variant, else the product's. null = the line has no catalogue product (a custom item). */
  measures: { weightKg: { toString(): string } | null; lengthCm: { toString(): string } | null; widthCm: { toString(): string } | null; heightCm: { toString(): string } | null } | null;
}

export interface MissingMeasurement {
  sku: string;
  name: string;
  fields: ("weight" | "length" | "breadth" | "height")[];
}

export interface ParcelInput { weight: number; length: number; breadth: number; height: number }
export type ParcelResult = { ok: true; input: ParcelInput; source: "PRODUCTS" | "ORDER_WEIGHT" } | { ok: false; missing: MissingMeasurement[] };

const positive = (v: { toString(): string } | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v.toString());
  return Number.isFinite(n) && n > 0 ? n : null;
};
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function parcelFromItems(items: MeasuredItem[], recordedOrderWeightKg: { toString(): string } | null = null): ParcelResult {
  const orderWeight = positive(recordedOrderWeightKg);
  const missing: MissingMeasurement[] = [];
  let weight = 0;
  let length = 0;
  let breadth = 0;
  let height = 0;
  for (const item of items) {
    const m = item.measures;
    const w = positive(m?.weightKg);
    const l = positive(m?.lengthCm);
    const b = positive(m?.widthCm);
    const h = positive(m?.heightCm);
    const fields: MissingMeasurement["fields"] = [];
    if (w === null && orderWeight === null) fields.push("weight");
    if (l === null) fields.push("length");
    if (b === null) fields.push("breadth");
    if (h === null) fields.push("height");
    if (fields.length > 0) {
      missing.push({ sku: item.skuSnapshot ?? "(no SKU)", name: item.variantNameSnapshot ? `${item.productNameSnapshot} - ${item.variantNameSnapshot}` : item.productNameSnapshot, fields });
      continue;
    }
    weight += (w ?? 0) * item.quantity;
    length = Math.max(length, l!);
    breadth = Math.max(breadth, b!);
    height = Math.max(height, h!);
  }
  if (items.length === 0) return { ok: false, missing: [{ sku: "(no items)", name: "The order has no items", fields: ["weight", "length", "breadth", "height"] }] };
  if (missing.length > 0) return { ok: false, missing };
  return orderWeight !== null
    ? { ok: true, input: { weight: round3(orderWeight), length, breadth, height }, source: "ORDER_WEIGHT" }
    : { ok: true, input: { weight: round3(weight), length, breadth, height }, source: "PRODUCTS" };
}

/** The reason shown on the order: every product with its exact missing fields. */
export function describeMissing(missing: MissingMeasurement[]): string {
  return `Product measurements are missing - ${missing.map((m) => `${m.sku} (${m.name}): ${m.fields.join(", ")}`).join("; ")}. Update these products, then retry.`;
}
