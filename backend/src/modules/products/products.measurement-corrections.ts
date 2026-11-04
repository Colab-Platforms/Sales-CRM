// Targeted measurement corrections: a reviewed CSV that names the exact SKUs and the exact fields to change. Separate from the catalogue upload (products.catalog-import.ts) and from the fill-only mode; neither is affected.
//
//  - Only the SKUs in the file are touched, and within a row only the fields that have a value. A blank cell is "no change", never "clear it".
//  - Every row says what it is allowed to do: FILL = write only where the CRM has no value (a recorded, different value is a conflict, not a write); REPLACE = the person has approved replacing a recorded value.
//  - Matching is by exact SKU only (a variant first, else a product). The product NAME is for the reader and is never used to find anything - so a bundle is corrected only once it has its own unique SKU.
//  - Nothing is rounded, defaulted or guessed: a value that is not a positive number inside the limits, or that has more decimals than the column stores, is an error. Any error blocks the whole apply (all or nothing).
//  - Dry run is the default; the writes happen in ONE transaction and only on apply. Re-running the same file changes nothing.
import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import { headerKey, looksLikeScientificNotation, MAX_DIMENSION_CM, MAX_UNIT_WEIGHT_KG } from "./products.catalog-parse.js";

export type CorrectionType = "FILL" | "REPLACE";
export type MeasureField = "weightKg" | "lengthCm" | "widthCm" | "heightCm";
export const FIELD_LABEL: Record<MeasureField, string> = { weightKg: "weight (kg)", lengthCm: "length (cm)", widthCm: "breadth (cm)", heightCm: "height (cm)" };
// CSV column (headerKey of "Proposed Weight (kg)" etc.) -> database field, with how many decimals the column stores.
const COLUMNS: { key: string; field: MeasureField; decimals: number; max: number }[] = [
  { key: "proposedweightkg", field: "weightKg", decimals: 3, max: MAX_UNIT_WEIGHT_KG },
  { key: "proposedlengthcm", field: "lengthCm", decimals: 2, max: MAX_DIMENSION_CM },
  { key: "proposedbreadthcm", field: "widthCm", decimals: 2, max: MAX_DIMENSION_CM },
  { key: "proposedheightcm", field: "heightCm", decimals: 2, max: MAX_DIMENSION_CM },
];

export interface CorrectionRow {
  line: number;
  sku: string;
  name: string | null;
  type: CorrectionType;
  values: Partial<Record<MeasureField, number>>;
}
export type ParsedCorrection = { kind: "row"; row: CorrectionRow } | { kind: "skip"; line: number; reason: string } | { kind: "error"; line: number; sku: string | null; message: string };

/** Pure. One CSV record (keyed by headerKey) -> a row to apply, a row to skip (nothing proposed), or an error. */
export function parseCorrectionRecord(record: Record<string, string>, line: number): ParsedCorrection {
  const get = (k: string) => (record[k] ?? "").trim();
  const sku = get("masterskucode");
  const name = get("productname") || null;
  const typed = COLUMNS.filter((c) => get(c.key) !== "");
  if (typed.length === 0) return { kind: "skip", line, reason: sku === "" ? `no SKU and nothing proposed${name ? ` (${name})` : ""}` : "nothing proposed" };
  if (sku === "") return { kind: "error", line, sku: null, message: `values are proposed but the row has no SKU${name ? ` (${name})` : ""}: rows are matched by SKU only, never by name` };
  if (looksLikeScientificNotation(sku)) return { kind: "error", line, sku, message: "the SKU looks like scientific notation (a spreadsheet damaged it)" };

  const typeText = get("updatetype").toUpperCase();
  if (typeText !== "FILL" && typeText !== "REPLACE") return { kind: "error", line, sku, message: `Update Type must be FILL or REPLACE (got "${get("updatetype")}")` };

  const values: Partial<Record<MeasureField, number>> = {};
  for (const c of typed) {
    const text = get(c.key);
    if (!/^\d+(\.\d+)?$/.test(text)) return { kind: "error", line, sku, message: `${FIELD_LABEL[c.field]} "${text}" is not a positive number` };
    const n = Number(text);
    if (!(n > 0)) return { kind: "error", line, sku, message: `${FIELD_LABEL[c.field]} must be greater than 0 (got ${text}); leave the cell blank for "no change"` };
    if (n > c.max) return { kind: "error", line, sku, message: `${FIELD_LABEL[c.field]} ${text} is above the limit of ${c.max}` };
    if ((text.split(".")[1] ?? "").length > c.decimals) return { kind: "error", line, sku, message: `${FIELD_LABEL[c.field]} "${text}" has more than ${c.decimals} decimal places; nothing is rounded for you` };
    values[c.field] = n;
  }
  return { kind: "row", row: { line, sku, name, type: typeText, values } };
}

export class NotACorrectionFileError extends Error {}

export async function* readCorrectionCsv(path: string): AsyncGenerator<{ record: Record<string, string>; line: number }> {
  const stream = createReadStream(path).pipe(parse({ bom: true, columns: (h: string[]) => h.map(headerKey), skip_empty_lines: true, relax_column_count: true, trim: true, cast: false }));
  let line = 1; // the header is line 1
  let checked = false;
  for await (const record of stream as AsyncIterable<Record<string, string>>) {
    line++;
    if (!checked) {
      checked = true;
      const keys = Object.keys(record);
      if (!keys.includes("masterskucode") || !keys.includes("updatetype") || !COLUMNS.some((c) => keys.includes(c.key))) {
        throw new NotACorrectionFileError("This is not a measurement-corrections file: it needs the columns Master SKU Code, Update Type and at least one Proposed ... column.");
      }
    }
    yield { record, line };
  }
}

export interface PlannedChange { field: MeasureField; from: string | null; to: number; kind: "FILL" | "REPLACE" }
export interface PlannedItem { line: number; sku: string; target: "variant" | "product"; id: string; label: string; changes: PlannedChange[] }
export interface CorrectionPlan {
  items: PlannedItem[];
  unchanged: { line: number; sku: string }[];
  skipped: { line: number; reason: string }[];
  errors: { line: number; sku: string | null; message: string }[];
}

const same = (current: { toString(): string } | null, next: number) => current !== null && Number(current.toString()) === next;

/** Reads the database (never writes) and decides, for every row, exactly what would change. */
export async function planCorrections(source: AsyncIterable<{ record: Record<string, string>; line: number }>, db: DbClient = prisma): Promise<CorrectionPlan> {
  const plan: CorrectionPlan = { items: [], unchanged: [], skipped: [], errors: [] };
  const rows: CorrectionRow[] = [];
  const seen = new Map<string, number>();
  for await (const { record, line } of source) {
    const parsed = parseCorrectionRecord(record, line);
    if (parsed.kind === "skip") plan.skipped.push({ line: parsed.line, reason: parsed.reason });
    else if (parsed.kind === "error") plan.errors.push({ line: parsed.line, sku: parsed.sku, message: parsed.message });
    else if (seen.has(parsed.row.sku)) plan.errors.push({ line, sku: parsed.row.sku, message: `duplicate SKU (also on line ${seen.get(parsed.row.sku)}): one row per SKU, so the intent is never ambiguous` });
    else { seen.set(parsed.row.sku, line); rows.push(parsed.row); }
  }
  if (rows.length === 0) return plan;

  const skus = rows.map((r) => r.sku);
  const select = { id: true, sku: true, name: true, weightKg: true, lengthCm: true, widthCm: true, heightCm: true } as const;
  const [variants, products] = await Promise.all([db.productVariant.findMany({ where: { sku: { in: skus } }, select }), db.product.findMany({ where: { sku: { in: skus } }, select })]);
  type Hit = { target: "variant" | "product"; id: string; name: string } & Record<MeasureField, { toString(): string } | null>;
  const hits = new Map<string, Hit[]>();
  const push = (target: Hit["target"], r: (typeof variants)[number]) => hits.set(r.sku!, [...(hits.get(r.sku!) ?? []), { target, id: r.id, name: r.name, weightKg: r.weightKg, lengthCm: r.lengthCm, widthCm: r.widthCm, heightCm: r.heightCm }]);
  variants.forEach((v) => push("variant", v));
  const variantSkus = new Set(variants.map((v) => v.sku));
  products.filter((p) => !variantSkus.has(p.sku)).forEach((p) => push("product", p));

  for (const row of rows) {
    const found = hits.get(row.sku) ?? [];
    if (found.length === 0) { plan.errors.push({ line: row.line, sku: row.sku, message: "unknown SKU: no product or variant in the CRM has this SKU" }); continue; }
    if (found.length > 1) { plan.errors.push({ line: row.line, sku: row.sku, message: "ambiguous SKU: more than one record has it" }); continue; }
    const hit = found[0]!;
    const changes: PlannedChange[] = [];
    const conflicts: string[] = [];
    for (const field of Object.keys(row.values) as MeasureField[]) {
      const next = row.values[field]!;
      const current = hit[field];
      if (current === null) changes.push({ field, from: null, to: next, kind: "FILL" });
      else if (same(current, next)) continue;
      else if (row.type === "REPLACE") changes.push({ field, from: current.toString(), to: next, kind: "REPLACE" });
      else conflicts.push(`${FIELD_LABEL[field]} is already ${current.toString()} (row is FILL; mark it REPLACE to approve replacing it with ${next})`);
    }
    if (conflicts.length > 0) { plan.errors.push({ line: row.line, sku: row.sku, message: conflicts.join("; ") }); continue; }
    if (changes.length === 0) plan.unchanged.push({ line: row.line, sku: row.sku });
    else plan.items.push({ line: row.line, sku: row.sku, target: hit.target, id: hit.id, label: hit.name, changes });
  }
  return plan;
}

/** All or nothing: refuses to write when the plan has any error, and writes every item in one transaction. Returns the number of records changed. */
export async function applyCorrections(plan: CorrectionPlan, db: DbClient = prisma): Promise<number> {
  if (plan.errors.length > 0) throw new Error(`Refusing to apply: ${plan.errors.length} row(s) have errors. Fix them and run the dry run again.`);
  const ops = plan.items.map((item) => {
    const data = Object.fromEntries(item.changes.map((c) => [c.field, c.to]));
    return item.target === "variant" ? db.productVariant.update({ where: { id: item.id }, data, select: { id: true } }) : db.product.update({ where: { id: item.id }, data, select: { id: true } });
  });
  if (db === prisma) await prisma.$transaction(ops);
  else for (const op of ops) await op;
  return ops.length;
}

export function formatPlan(plan: CorrectionPlan, applied: boolean): string[] {
  const out: string[] = [];
  for (const item of plan.items) {
    out.push(`${applied ? "CHANGED" : "WILL CHANGE"}  ${item.sku}  (${item.target} "${item.label}", line ${item.line})`);
    for (const c of item.changes) out.push(`    ${FIELD_LABEL[c.field]}: ${c.from ?? "(none)"} -> ${c.to}   [${c.kind}]`);
  }
  for (const u of plan.unchanged) out.push(`no change    ${u.sku}  (line ${u.line}): already has these values`);
  for (const s of plan.skipped) out.push(`skipped      line ${s.line}: ${s.reason}`);
  for (const e of plan.errors) out.push(`ERROR        line ${e.line}${e.sku ? `  ${e.sku}` : ""}: ${e.message}`);
  out.push(`\n${plan.items.length} record(s) ${applied ? "changed" : "would change"}, ${plan.unchanged.length} already correct, ${plan.skipped.length} skipped (nothing proposed), ${plan.errors.length} error(s).`);
  return out;
}
