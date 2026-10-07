// Parsing one row of a Shiprocket catalog export (Settings > Catalog > Export Products). Pure: no I/O.
//
// Codes (SKU, Master SKU, Channel SKU, Channel Product id) are IDENTIFIERS and always stay strings - they are never cast to numbers. A code that
// looks like scientific notation ("8.00994E+12") has already been destroyed by a spreadsheet, so the row is rejected instead of being matched
// on a corrupted value.

export interface CatalogDimensions {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface ParsedCatalogRow {
  /** Candidate CRM SKUs, strongest identity first: Master SKU Code, then SKU Code, then Channel SKU Code (de-duplicated, trimmed). */
  skus: string[];
  name: string | null;
  channel: string | null;
  /** Unit weight in kg; null = the catalog has none (blank or 0 means "not recorded", never "weightless"). */
  weightKg: number | null;
  /** Unit dimensions in cm; null = the catalog has none (blank, or any side 0). */
  dimensions: CatalogDimensions | null;
}

export type CatalogRowResult = { ok: true; row: ParsedCatalogRow } | { ok: false; reason: string; sku: string | null };

export const MAX_UNIT_WEIGHT_KG = 100;
export const MAX_DIMENSION_CM = 300;

/** Header text -> a stable key: "*SKU Code" -> "skucode", "Master SKU Code" -> "masterskucode". */
export function headerKey(header: string): string {
  return header.replace(/^﻿/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SCIENTIFIC = /^[+-]?\d+(\.\d+)?e[+-]?\d+$/i;

/** True when a code was turned into a float by a spreadsheet ("8.00994E+12") - it can no longer identify anything. */
export const looksLikeScientificNotation = (code: string): boolean => SCIENTIFIC.test(code.trim());

export function parseWeightKg(raw: string): { ok: true; kg: number | null } | { ok: false; reason: string } {
  const text = raw.trim();
  if (text === "") return { ok: true, kg: null };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, reason: `Weight "${text}" is not a number` };
  const kg = Number(text);
  if (kg === 0) return { ok: true, kg: null };
  if (kg > MAX_UNIT_WEIGHT_KG) return { ok: false, reason: `Weight ${kg} kg is above ${MAX_UNIT_WEIGHT_KG} kg (is it in grams?)` };
  return { ok: true, kg: Number(kg.toFixed(3)) };
}

/** "20.000x15.000x2.000" -> 20 x 15 x 2. Blank or any zero side -> not recorded. Anything else malformed is an error. */
export function parseDimensions(raw: string): { ok: true; dimensions: CatalogDimensions | null } | { ok: false; reason: string } {
  const text = raw.trim();
  if (text === "") return { ok: true, dimensions: null };
  const m = /^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)$/i.exec(text);
  if (!m) return { ok: false, reason: `Dimensions "${text}" are not in LxBxH form` };
  const [l, w, h] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (l === 0 || w === 0 || h === 0) return { ok: true, dimensions: null };
  if (l > MAX_DIMENSION_CM || w > MAX_DIMENSION_CM || h > MAX_DIMENSION_CM) return { ok: false, reason: `Dimensions ${text} exceed ${MAX_DIMENSION_CM} cm` };
  const r = (n: number) => Number(n.toFixed(2));
  return { ok: true, dimensions: { lengthCm: r(l), widthCm: r(w), heightCm: r(h) } };
}

/** `record` is keyed by headerKey(). */
export function parseCatalogRow(record: Record<string, string>): CatalogRowResult {
  const get = (k: string) => (record[k] ?? "").trim();
  const codes = [get("masterskucode"), get("skucode"), get("channelskucode")].filter((c) => c !== "");
  const first = codes[0] ?? null;
  if (codes.length === 0) return { ok: false, reason: "Row has no SKU code", sku: null };
  const damaged = codes.find(looksLikeScientificNotation);
  if (damaged) return { ok: false, reason: `SKU "${damaged}" looks like scientific notation - the file was saved through a spreadsheet that corrupted the code`, sku: first };

  const weight = parseWeightKg(get("weight"));
  if (!weight.ok) return { ok: false, reason: weight.reason, sku: first };
  const dims = parseDimensions(get("dimensions"));
  if (!dims.ok) return { ok: false, reason: dims.reason, sku: first };

  return {
    ok: true,
    row: { skus: [...new Set(codes)], name: get("productname") || null, channel: get("channelname") || null, weightKg: weight.kg, dimensions: dims.dimensions },
  };
}
