// Shiprocket catalog import: supplements EXISTING CRM products/variants with weight and dimensions. It never creates, renames or re-identifies a
// product, so the Shopify identities (externalId, SKU, mappings) are untouched and uploading the same file twice changes nothing the second time.
//
// Scale: the file is streamed from disk (never held in memory), counted once for the progress total, then processed in batches
// (BATCH_SIZE rows = 2 lookups + one short write transaction each), so thousands of SKUs are fine and a failure is confined to one batch.
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse";
import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import { headerKey, parseCatalogRow, type ParsedCatalogRow } from "./products.catalog-parse.js";

export const BATCH_SIZE = 500;
const MAX_FAILED_ROWS_KEPT = 50_000;
const JOB_TTL_MS = 60 * 60_000;

export type FailedRowStatus = "skipped" | "unmatched" | "error";
export interface FailedRow {
  row: number;
  sku: string | null;
  name: string | null;
  status: FailedRowStatus;
  reason: string;
}

export interface CatalogImportSummary {
  total: number;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  unmatched: number;
  errors: number;
}

const emptySummary = (): CatalogImportSummary => ({ total: 0, imported: 0, updated: 0, unchanged: 0, skipped: 0, unmatched: 0, errors: 0 });

type Target = { kind: "product" | "variant"; id: string; weightKg: string | null; lengthCm: string | null; widthCm: string | null; heightCm: string | null };

const dec = (v: { toString(): string } | null) => (v === null ? null : v.toString());
const same = (a: string | null, b: number | null) => (a === null || b === null ? a === null && b === null : Number(a) === b);

/** Rows come from `rows` already keyed by headerKey(). Pure with respect to the file: only the DB is touched. */
export async function importCatalogRows(
  rows: AsyncIterable<Record<string, string>>,
  opts: { db?: DbClient; total?: number; batchSize?: number; onProgress?: (processed: number, summary: CatalogImportSummary) => void; failedRows?: FailedRow[] } = {},
): Promise<CatalogImportSummary> {
  const db = opts.db ?? prisma;
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const summary = emptySummary();
  const failed = opts.failedRows ?? [];
  const seen = new Set<string>();
  let batch: { row: number; parsed: ParsedCatalogRow }[] = [];
  let rowNo = 0;

  const fail = (row: number, sku: string | null, name: string | null, status: FailedRowStatus, reason: string) => {
    if (status === "skipped") summary.skipped++;
    else if (status === "unmatched") summary.unmatched++;
    else summary.errors++;
    if (failed.length < MAX_FAILED_ROWS_KEPT) failed.push({ row, sku, name, status, reason });
  };

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    const codes = [...new Set(current.flatMap((b) => b.parsed.skus))];
    const [variants, products] = await Promise.all([
      db.productVariant.findMany({ where: { sku: { in: codes } }, select: { id: true, sku: true, weightKg: true, lengthCm: true, widthCm: true, heightCm: true } }),
      db.product.findMany({ where: { sku: { in: codes } }, select: { id: true, sku: true, weightKg: true, lengthCm: true, widthCm: true, heightCm: true } }),
    ]);
    const bySku = new Map<string, Target[]>();
    const add = (kind: Target["kind"], r: { id: string; sku: string | null; weightKg: unknown; lengthCm: unknown; widthCm: unknown; heightCm: unknown }) => {
      if (!r.sku) return;
      const t: Target = { kind, id: r.id, weightKg: dec(r.weightKg as never), lengthCm: dec(r.lengthCm as never), widthCm: dec(r.widthCm as never), heightCm: dec(r.heightCm as never) };
      bySku.set(r.sku, [...(bySku.get(r.sku) ?? []), t]);
    };
    // Variants are the sellable units, so a SKU that exists on a variant is that variant; a bare product SKU is the fallback.
    variants.forEach((v) => add("variant", v));
    const variantSkus = new Set(variants.map((v) => v.sku));
    products.filter((p) => !variantSkus.has(p.sku)).forEach((p) => add("product", p));

    const writes: { target: Target; data: Record<string, number> }[] = [];
    for (const { row, parsed } of current) {
      const code = parsed.skus.find((c) => bySku.has(c));
      if (!code) {
        fail(row, parsed.skus[0] ?? null, parsed.name, "unmatched", "No product or variant with this SKU in the CRM");
        continue;
      }
      const targets = bySku.get(code)!;
      let changed = false;
      let firstTime = false;
      for (const t of targets) {
        const data: Record<string, number> = {};
        if (parsed.weightKg !== null && !same(t.weightKg, parsed.weightKg)) data.weightKg = parsed.weightKg;
        const d = parsed.dimensions;
        if (d && !(same(t.lengthCm, d.lengthCm) && same(t.widthCm, d.widthCm) && same(t.heightCm, d.heightCm))) Object.assign(data, d);
        if (Object.keys(data).length === 0) continue;
        changed = true;
        if (t.weightKg === null && t.lengthCm === null) firstTime = true;
        writes.push({ target: t, data });
      }
      if (!changed) summary.unchanged++;
      else if (firstTime) summary.imported++;
      else summary.updated++;
    }
    if (writes.length > 0) {
      const ops = writes.map(({ target, data }) =>
        target.kind === "variant" ? db.productVariant.update({ where: { id: target.id }, data, select: { id: true } }) : db.product.update({ where: { id: target.id }, data, select: { id: true } }),
      );
      // One short transaction per batch. (When the caller already runs inside a transaction - the DB tests - there is nothing to open.)
      if (db === prisma) await prisma.$transaction(ops);
      else for (const op of ops) await op;
    }
  }

  for await (const record of rows) {
    rowNo++;
    summary.total++;
    const result = parseCatalogRow(record);
    if (!result.ok) {
      fail(rowNo, result.sku, record.productname?.trim() || null, "error", result.reason);
    } else {
      const { row } = result;
      const key = row.skus[0]!;
      if (row.weightKg === null && row.dimensions === null) {
        fail(rowNo, key, row.name, "skipped", "No weight or dimensions recorded in the catalog for this SKU");
      } else if (seen.has(key)) {
        fail(rowNo, key, row.name, "skipped", "Duplicate SKU in the file - the first occurrence was used");
      } else {
        seen.add(key);
        batch.push({ row: rowNo, parsed: row });
      }
    }
    if (batch.length >= batchSize) {
      await flush();
      opts.onProgress?.(rowNo, summary);
    }
  }
  await flush();
  opts.onProgress?.(rowNo, summary);
  return summary;
}

// ---- Reading the CSV ------------------------------------------------------------------------------------------------------------------
const csvParser = () => parse({ bom: true, columns: (h: string[]) => h.map(headerKey), skip_empty_lines: true, relax_column_count: true, trim: true, cast: false });

export class NotACatalogError extends Error {}

/** Streams the file's records, keyed by normalised header. Throws NotACatalogError when the header has no SKU column or neither weight nor dimensions. */
export async function* readCatalogCsv(path: string): AsyncGenerator<Record<string, string>> {
  const stream = createReadStream(path).pipe(csvParser());
  let checked = false;
  for await (const record of stream as AsyncIterable<Record<string, string>>) {
    if (!checked) {
      checked = true;
      const keys = Object.keys(record);
      const hasSku = keys.some((k) => k === "skucode" || k === "masterskucode");
      if (!hasSku || !(keys.includes("weight") || keys.includes("dimensions"))) {
        throw new NotACatalogError("This does not look like a Shiprocket catalog export: it needs SKU Code (or Master SKU Code) and Weight / Dimensions columns.");
      }
    }
    yield record;
  }
}

async function countRecords(path: string): Promise<number> {
  let n = 0;
  for await (const _ of createReadStream(path).pipe(csvParser())) n++;
  return n;
}

// ---- Jobs (progress for the UI) --------------------------------------------------------------------------------------------------------
export interface CatalogImportJob {
  id: string;
  fileName: string;
  status: "running" | "completed" | "failed";
  total: number;
  processed: number;
  summary: CatalogImportSummary;
  failedRows: FailedRow[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// Held in this process only: the import is idempotent, so after a restart the person simply uploads the file again.
const jobs = new Map<string, CatalogImportJob>();
const prune = () => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) if (j.finishedAt && Date.parse(j.finishedAt) < cutoff) jobs.delete(id);
};

export const getCatalogImportJob = (id: string): CatalogImportJob | undefined => jobs.get(id);
export const hasRunningCatalogImport = (): boolean => [...jobs.values()].some((j) => j.status === "running");

/** Starts the import in the background and returns at once; poll the job for progress. `cleanup` removes the uploaded temp file. */
export async function startCatalogImport(input: { path: string; fileName: string; cleanup?: () => Promise<void> | void }, db: DbClient = prisma): Promise<CatalogImportJob> {
  prune();
  const job: CatalogImportJob = { id: randomUUID(), fileName: input.fileName, status: "running", total: 0, processed: 0, summary: emptySummary(), failedRows: [], error: null, startedAt: new Date().toISOString(), finishedAt: null };
  jobs.set(job.id, job);
  // Validate the header before answering so a wrong file is a clear 400 instead of a background failure.
  const iterator = readCatalogCsv(input.path);
  const first = await iterator.next().catch((e) => e);
  if (first instanceof Error) {
    jobs.delete(job.id);
    await input.cleanup?.();
    throw first;
  }
  await iterator.return?.(undefined);
  void (async () => {
    try {
      job.total = await countRecords(input.path);
      job.summary = await importCatalogRows(readCatalogCsv(input.path), {
        db,
        total: job.total,
        failedRows: job.failedRows,
        onProgress: (processed, summary) => {
          job.processed = processed;
          job.summary = { ...summary };
        },
      });
      job.processed = job.total;
      job.status = "completed";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "Import failed";
    } finally {
      job.finishedAt = new Date().toISOString();
      await input.cleanup?.();
    }
  })();
  return job;
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function failedRowsCsv(rows: FailedRow[]): string {
  return ["row,sku,product_name,status,reason", ...rows.map((r) => [r.row, r.sku, r.name, r.status, r.reason].map(csvCell).join(","))].join("\n") + "\n";
}
