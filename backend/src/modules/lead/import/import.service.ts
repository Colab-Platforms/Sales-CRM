import { unlink } from "node:fs/promises";
import type { Response } from "express";
import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { classifyCustomer } from "@/lib/customerClass.js";
import { ImportBatchStatus, Role } from "../../../../generated/prisma/enums.js";
import { Prisma } from "../../../../generated/prisma/client.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { segmentService } from "../../segments/segments.service.js";
import { detectColumns, IMPORT_FIELDS, readCustomer, rowProblem, type ColumnMapping, type ImportField } from "./import.columns.js";
import { readRows, uniqueHeaders } from "./import.file.js";
import { enqueueImport, isImportRunning } from "./import.runner.js";
import { taggingColumn, taggingTally, type TaggingSummary } from "./import.tagging.js";

// FILE IMPORT v2 (Excel / CSV): upload & stage -> detected columns (+ optional manual fixes) -> preview with duplicate / invalid counts -> background import with live progress -> failed-rows download.
// The upload request only STAGES the file's rows (LeadImportRow); nothing becomes a lead until the user confirms, and the heavy work runs outside the HTTP request (import.runner.ts).

export const MAX_ROWS = 250_000;
const STAGE_CHUNK = 2000;
const PREVIEW_PAGE = 5000;

type StoredMapping = { v: 2; headers: string[]; mapping: ColumnMapping };
const isStored = (v: unknown): v is StoredMapping => Boolean(v && typeof v === "object" && (v as StoredMapping).v === 2 && Array.isArray((v as StoredMapping).headers));

export type ImportPreview = {
  totalRows: number;
  eligibleRows: number;
  invalidRows: number;
  /** Every eligible row becomes a new lead (nothing is matched, merged or skipped). */
  newLeads: number;
  missingPhone: number;
  missingOrderCount: number;
  invalidOrderCount: number;
  classification: { repeat: number; loyal: number; vip: number; unclassified: number };
  problems: { row: number; reason: string }[];
  /** Lead statuses from the Tagging column, counted over the rows that will be imported; null when the file has no such column. */
  tagging: TaggingSummary | null;
};

class LeadImportService {
  private async getBatch(user: AuthUser, batchId: string) {
    const batch = await prisma.leadImportBatch.findUnique({ where: { id: batchId } });
    // a manager only ever sees their own batches; 404 (not 403) so another batch's existence is not leaked
    if (!batch || !isStored(batch.columnMapping) || (user.role === Role.MANAGER && batch.uploadedById !== user.id)) throw new ApiError("Import not found", STATUS_CODES.NOT_FOUND);
    return { batch, stored: batch.columnMapping as StoredMapping };
  }

  // ---------------------------------------------------------------------------------------------- 1. upload & detect

  async analyze(user: AuthUser, file: { path: string; originalname: string }, segmentId?: string) {
    try {
      if (segmentId) await segmentService.requireUsable(segmentId);
      const batch = await prisma.leadImportBatch.create({
        data: { fileName: file.originalname.slice(0, 255), uploadedById: user.id, status: ImportBatchStatus.DRAFT, columnMapping: { v: 2, headers: [], mapping: {} }, segmentId: segmentId ?? null },
        select: { id: true },
      });
      try {
        let headers: string[] | null = null;
        let buffer: Prisma.LeadImportRowCreateManyInput[] = [];
        let staged = 0;
        const sample: Record<string, string>[] = [];
        for await (const row of readRows(file.path, file.originalname)) {
          if (!headers) {
            headers = uniqueHeaders(row.values);
            continue;
          }
          if (staged >= MAX_ROWS) throw new ApiError(`The file has more than ${MAX_ROWS.toLocaleString("en-IN")} rows. Split it into smaller files.`, STATUS_CODES.BAD_REQUEST);
          const data: Record<string, string> = {};
          headers.forEach((h, i) => {
            const v = row.values[i];
            if (v !== undefined && v !== "") data[h] = v;
          });
          if (Object.keys(data).length === 0) continue;
          if (sample.length < 3) sample.push(data);
          buffer.push({ batchId: batch.id, rowNumber: row.rowNumber, data });
          staged += 1;
          if (buffer.length >= STAGE_CHUNK) {
            await prisma.leadImportRow.createMany({ data: buffer });
            buffer = [];
          }
        }
        if (buffer.length) await prisma.leadImportRow.createMany({ data: buffer });
        if (!headers || headers.length === 0) throw new ApiError("The file has no header row.", STATUS_CODES.BAD_REQUEST);
        if (staged === 0) throw new ApiError("The file has a header row but no customer rows.", STATUS_CODES.BAD_REQUEST);

        const remembered = await prisma.leadImportMapping.findUnique({ where: { signature: detectColumns(headers).signature } });
        const detection = detectColumns(headers, (remembered?.mapping as ColumnMapping | undefined) ?? null);
        await prisma.leadImportBatch.update({ where: { id: batch.id }, data: { totalRows: staged, signature: detection.signature, columnMapping: { v: 2, headers, mapping: detection.mapping } as unknown as Prisma.InputJsonValue } });
        const preview = await this.computePreview(batch.id, detection.mapping, headers);
        return {
          batchId: batch.id,
          fileName: file.originalname,
          totalRows: staged,
          segmentId: segmentId ?? null,
          rememberedMapping: Boolean(remembered),
          columns: detection.columns.map((c) => ({ ...c, samples: sample.map((s) => s[c.header]).filter((v): v is string => Boolean(v)) })),
          mapping: detection.mapping,
          needsReview: detection.needsReview.map((c) => ({ header: c.header, conflictWith: c.conflictWith })),
          unrecognized: detection.unrecognized.map((c) => c.header),
          preview,
        };
      } catch (error) {
        await prisma.leadImportBatch.delete({ where: { id: batch.id } }).catch(() => undefined);
        throw error;
      }
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------------------------- 2. mapping & preview

  /** Counts for the preview step, from the staged rows and the CRM's current leads. Reads the rows page by page: never the whole file at once. */
  async computePreview(batchId: string, mapping: ColumnMapping, headers: readonly string[]): Promise<ImportPreview> {
    const column = taggingColumn(headers);
    const tally = column ? taggingTally(column) : null;
    const p: ImportPreview = { totalRows: 0, eligibleRows: 0, invalidRows: 0, newLeads: 0, missingPhone: 0, missingOrderCount: 0, invalidOrderCount: 0, classification: { repeat: 0, loyal: 0, vip: 0, unclassified: 0 }, problems: [], tagging: null };
    let cursor = 0;
    for (;;) {
      const rows = await prisma.leadImportRow.findMany({ where: { batchId, id: { gt: cursor } }, orderBy: { id: "asc" }, take: PREVIEW_PAGE, select: { id: true, rowNumber: true, data: true } });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;
      const parsed = rows.map((r) => ({ r, c: readCustomer(r.data as Record<string, string>, mapping) }));
      for (const { r, c } of parsed) {
        p.totalRows += 1;
        if (!c.mobile) p.missingPhone += 1;
        const problem = rowProblem(c);
        if (problem) {
          p.invalidRows += 1;
          if (p.problems.length < 20) p.problems.push({ row: r.rowNumber, reason: problem });
          continue;
        }
        if (c.orderCount.state === "missing") p.missingOrderCount += 1;
        else if (c.orderCount.state === "invalid") p.invalidOrderCount += 1;
        p.eligibleRows += 1;
        p.newLeads += 1;
        tally?.add((r.data as Record<string, string>)[column!]);
        const cls = classifyCustomer(c.orderCount.state === "ok" ? c.orderCount.value : null);
        if (cls === "REPEAT") p.classification.repeat += 1;
        else if (cls === "LOYAL") p.classification.loyal += 1;
        else if (cls === "VIP") p.classification.vip += 1;
        else p.classification.unclassified += 1;
      }
    }
    p.tagging = tally?.summary() ?? null;
    return p;
  }

  /** Applies the user's manual column choices (only needed for ambiguous / unrecognised columns) and the segment, then re-computes the preview. */
  async updateMapping(user: AuthUser, batchId: string, input: { mapping?: Record<string, string>; segmentId?: string | null }) {
    const { batch, stored } = await this.getBatch(user, batchId);
    if (batch.status !== ImportBatchStatus.DRAFT) throw new ApiError("This import has already started.", STATUS_CODES.CONFLICT);
    let mapping = stored.mapping;
    if (input.mapping) {
      const next: ColumnMapping = { ...mapping };
      for (const [header, field] of Object.entries(input.mapping)) {
        if (!stored.headers.includes(header)) throw new ApiError(`Unknown column "${header.slice(0, 60)}"`, STATUS_CODES.BAD_REQUEST);
        if (!(IMPORT_FIELDS as readonly string[]).includes(field)) throw new ApiError(`Unknown field "${field.slice(0, 40)}"`, STATUS_CODES.BAD_REQUEST);
        next[header] = field as ImportField;
      }
      mapping = next;
      await prisma.leadImportBatch.update({ where: { id: batchId }, data: { columnMapping: { v: 2, headers: stored.headers, mapping } as unknown as Prisma.InputJsonValue } });
    }
    if (input.segmentId !== undefined) {
      if (input.segmentId) await segmentService.requireUsable(input.segmentId);
      await prisma.leadImportBatch.update({ where: { id: batchId }, data: { segmentId: input.segmentId } });
    }
    return { batchId, mapping, preview: await this.computePreview(batchId, mapping, stored.headers) };
  }

  // ---------------------------------------------------------------------------------------------- 3. start & progress

  async start(user: AuthUser, batchId: string, input: { segmentId?: string | null } = {}) {
    const { batch, stored } = await this.getBatch(user, batchId);
    const resumable = batch.status === ImportBatchStatus.FAILED || (batch.status === ImportBatchStatus.PROCESSING && !isImportRunning(batchId));
    if (batch.status !== ImportBatchStatus.DRAFT && !resumable) throw new ApiError(batch.status === ImportBatchStatus.PROCESSING ? "This import is already running." : "This import has already finished.", STATUS_CODES.CONFLICT);
    const mapped = Object.values(stored.mapping);
    if (!mapped.includes("mobile") && !mapped.includes("email")) throw new ApiError("Map a phone number or email column before importing.", STATUS_CODES.BAD_REQUEST);
    const segmentId = input.segmentId !== undefined ? input.segmentId : batch.segmentId;
    if (segmentId && segmentId !== batch.segmentId) await segmentService.requireUsable(segmentId);
    if (segmentId && batch.status === ImportBatchStatus.DRAFT) await segmentService.requireUsable(segmentId);
    await prisma.leadImportBatch.update({ where: { id: batchId }, data: { status: ImportBatchStatus.PROCESSING, segmentId: segmentId ?? null, startedAt: batch.startedAt ?? new Date(), finishedAt: null, lastError: null } });
    if (batch.signature) {
      await prisma.leadImportMapping.upsert({
        where: { signature: batch.signature },
        create: { signature: batch.signature, mapping: stored.mapping, createdById: user.id },
        update: { mapping: stored.mapping, useCount: { increment: 1 }, lastUsedAt: new Date() },
      });
    }
    enqueueImport(batchId);
    return this.progress(user, batchId);
  }

  /** The Tagging summary of the leads an import actually created, grouped in the database. */
  private async importedTagging(batchId: string, headers: readonly string[]): Promise<TaggingSummary | null> {
    const column = taggingColumn(headers);
    if (!column) return null;
    const grouped = await prisma.$queryRaw<{ value: string | null; count: number }[]>`
      SELECT data ->> ${column}::text AS value, count(*)::int AS count FROM lead_import_rows WHERE batch_id = ${batchId}::uuid AND status = 'CREATED' GROUP BY 1`;
    const tally = taggingTally(column);
    for (const g of grouped) tally.add(g.value, g.count);
    return tally.summary();
  }

  async progress(user: AuthUser, batchId: string) {
    const { batch, stored } = await this.getBatch(user, batchId);
    // only once the import has stopped: progress is polled while it runs, and the preview already shows what is coming
    const ended = batch.status === ImportBatchStatus.COMMITTED || batch.status === ImportBatchStatus.FAILED;
    const tagging = ended ? await this.importedTagging(batchId, stored.headers) : null;
    const pending = await prisma.leadImportRow.count({ where: { batchId, status: "PENDING" } });
    const total = batch.totalRows;
    return {
      batchId,
      fileName: batch.fileName,
      status: batch.status,
      segmentId: batch.segmentId,
      totalRows: total,
      processedRows: batch.processedRows,
      pendingRows: pending,
      percent: total > 0 ? Math.min(100, Math.floor((batch.processedRows / total) * 100)) : 0,
      created: batch.createdRows,
      updated: batch.updatedRows,
      segmentMembershipsAdded: batch.segmentAdded,
      duplicates: batch.duplicateRows,
      failed: batch.failedRows,
      tagging,
      startedAt: batch.startedAt,
      finishedAt: batch.finishedAt,
      error: batch.lastError,
      // FAILED with rows left = stopped part-way and resumable; COMMITTED = finished
      canResume: batch.status === ImportBatchStatus.FAILED && pending > 0,
    };
  }

  // ---------------------------------------------------------------------------------------------- 4. reports

  /** The rows that failed (or were duplicates), with the reason, as a CSV the user can fix and re-upload. */
  async streamReport(user: AuthUser, batchId: string, kind: "failed" | "duplicates", res: Response): Promise<void> {
    const { batch, stored } = await this.getBatch(user, batchId);
    const status = kind === "failed" ? "FAILED" : "DUPLICATE";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="import-${kind}-${batch.id.slice(0, 8)}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    const head = ["Row", "Reason", ...stored.headers];
    res.write("﻿" + head.map(csvCell).join(",") + "\r\n");
    let cursor = 0;
    for (;;) {
      const rows = await prisma.leadImportRow.findMany({ where: { batchId, status, id: { gt: cursor } }, orderBy: { id: "asc" }, take: 2000, select: { id: true, rowNumber: true, reason: true, data: true } });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;
      res.write(rows.map((r) => [String(r.rowNumber), r.reason ?? "", ...stored.headers.map((h) => (r.data as Record<string, string>)[h] ?? "")].map(csvCell).join(",")).join("\r\n") + "\r\n");
    }
    res.end();
  }
}

/** CSV cell, quoted when needed; a cell that starts like a formula is neutralised so opening the report in Excel cannot run it. */
export function csvCell(value: string): string {
  let v = value ?? "";
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const leadImportService = new LeadImportService();
export default LeadImportService;
