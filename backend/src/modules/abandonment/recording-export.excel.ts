import { Writable } from "node:stream";
import ExcelJS from "exceljs";
import { recordingStamp } from "./abandonment.recordings.js";
import { FatalExportError, guardedRun, resolveOptions, retryTransient, type BlobStore, type ExportJobRow, type ExportRepo, type RunOptions, type RunOutcome } from "./recording-export.core.js";

// The Excel export of abandoned-lead records. It runs as a background job on the same machinery as the recording ZIP (queue, progress, durable storage, retention), but needs no
// per-item rows: the data is read page by page (keyset pagination, never OFFSET, never the whole result at once), each row is committed to a STREAMING workbook the moment it is
// built, and the workbook streams straight into the blob store. Memory stays flat from 20 rows to hundreds of thousands. Audio is never embedded.

export interface ExcelRow {
  leadNumber: string;
  customerName: string;
  mobile: string | null;
  email: string | null;
  items: string;
  orderValue: number | null;
  currency: string | null;
  detectedAt: Date;
  leadStatus: string;
  callAttempts: number;
  successfulCalls: number;
  assignedTo: string;
  manager: string;
  recordingAvailable: boolean;
  recordingCount: number;
  checkoutReference: string | null;
  customerOrders: number;
  latestOrder: string | null;
}

/** Where the rows come from. The production source reads Postgres; tests supply a generator. */
export interface ExcelSource {
  count(): Promise<number>;
  pages(): AsyncIterable<ExcelRow[]>;
}

export const EXCEL_COLUMNS: { header: string; key: keyof ExcelRow; width: number }[] = [
  { header: "Lead ID", key: "leadNumber", width: 18 },
  { header: "Customer name", key: "customerName", width: 24 },
  { header: "Contact number", key: "mobile", width: 16 },
  { header: "Email", key: "email", width: 28 },
  { header: "Items", key: "items", width: 44 },
  { header: "Order value", key: "orderValue", width: 14 },
  { header: "Currency", key: "currency", width: 10 },
  { header: "Detected (IST)", key: "detectedAt", width: 18 },
  { header: "Lead status", key: "leadStatus", width: 16 },
  { header: "Call attempts", key: "callAttempts", width: 14 },
  { header: "Answered calls", key: "successfulCalls", width: 15 },
  { header: "Assigned salesperson", key: "assignedTo", width: 22 },
  { header: "Assigned manager", key: "manager", width: 20 },
  { header: "Recording available", key: "recordingAvailable", width: 20 },
  { header: "Recordings", key: "recordingCount", width: 12 },
  { header: "Checkout reference", key: "checkoutReference", width: 24 },
  { header: "Customer orders", key: "customerOrders", width: 16 },
  { header: "Latest order", key: "latestOrder", width: 18 },
];

/** The cell value for one column. Dates are written as IST text so the sheet reads the same in every viewer's time zone. */
export function excelCell(row: ExcelRow, key: keyof ExcelRow): string | number | null {
  const v = row[key];
  if (v instanceof Date) return recordingStamp(v).replace("_", " ").replace(/(\d{2})(\d{2})$/, "$1:$2");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return v as string | number | null;
}

export type ExcelSourceFactory = (job: ExportJobRow) => ExcelSource;

export async function runExcelExport(deps: { repo: ExportRepo; store: BlobStore; source: ExcelSourceFactory }, jobId: string, partial: Partial<RunOptions> = {}): Promise<RunOutcome> {
  const opts = resolveOptions(partial);
  const { repo, store } = deps;
  const job = await repo.claim(jobId, opts.staleMs);
  if (!job) return "skipped";

  return guardedRun(repo, jobId, opts, async () => {
    const source = deps.source(job);
    const total = await retryTransient(() => source.count(), opts, "count rows");
    if (!(await retryTransient(() => repo.progress(jobId, { total, processed: 0, failed: 0, dataEnd: 0 }), opts, "progress"))) return "skipped";

    // An Excel file is rebuilt from the start on a retry (rows are cheap; a half-written workbook cannot be resumed).
    const writer = await retryTransient(() => store.openWriter(jobId, 0), opts, "open storage");
    let sinkError: Error | null = null;
    const sink = new Writable({
      highWaterMark: 1024 * 1024,
      write(chunk: Buffer, _enc, cb) {
        writer.write(chunk).then(() => cb(), (e: unknown) => {
          sinkError = e instanceof Error ? e : new Error("storage write failed");
          cb(sinkError);
        });
      },
    });
    sink.on("error", () => undefined); // surfaced through sinkError / the awaited finish below

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: true, useSharedStrings: false });
    const sheet = workbook.addWorksheet("Abandoned leads", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = EXCEL_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: EXCEL_COLUMNS.length } };
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.commit();
    const valueColumn = EXCEL_COLUMNS.findIndex((c) => c.key === "orderValue") + 1;
    sheet.getColumn(valueColumn).numFmt = "#,##0.00";

    let written = 0;
    for await (const page of source.pages()) {
      if (sinkError) throw sinkError;
      if (written + page.length > opts.maxRows) throw new FatalExportError(`More than ${opts.maxRows} rows match. Choose a shorter date range.`);
      for (const row of page) {
        sheet.addRow(EXCEL_COLUMNS.map((c) => excelCell(row, c.key))).commit();
        written++;
      }
      const alive = await retryTransient(() => repo.progress(jobId, { processed: written }), opts, "progress");
      if (!alive) return "skipped";
      // Hand control back between pages so a large export never starves the web requests sharing this process.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const summary = workbook.addWorksheet("Summary");
    summary.addRow(["Abandoned leads export"]).font = { bold: true };
    summary.addRow(["Date range (IST)", job.fromDay === job.toDay ? job.fromDay : `${job.fromDay} to ${job.toDay}`]);
    summary.addRow(["Generated (IST)", recordingStamp(opts.now()).replace("_", " ").replace(/(\d{2})(\d{2})$/, "$1:$2")]);
    summary.addRow(["Rows", written]);
    summary.getColumn(1).width = 22;
    summary.getColumn(2).width = 30;
    summary.commit();
    sheet.commit();

    const finished = new Promise<void>((resolve, reject) => {
      sink.once("finish", resolve);
      sink.once("error", reject);
    });
    await workbook.commit();
    await finished;
    if (sinkError) throw sinkError;
    await retryTransient(() => writer.flush(), opts, "flush storage");
    await retryTransient(() => repo.progress(jobId, { total: Math.max(total, written), processed: written, failed: 0, dataEnd: writer.offset }), opts, "progress");
    const fileName = `abandoned-leads_${job.fromDay}_to_${job.toDay}.xlsx`;
    await retryTransient(() => repo.finish(jobId, { status: "COMPLETED", sizeBytes: writer.offset, dataEnd: writer.offset, fileName, errorMessage: null }), opts, "finish");
    return "completed";
  });
}
