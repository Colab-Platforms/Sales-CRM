import type { AuthUser } from "@/middlewares/auth.js";
import { CallRecordingsService, type CallRecordingFilters, type CallRecordingItem } from "./call-recordings.service.js";
import { istText, type ExcelLayout, type ExcelSource } from "./recording-export.excel.js";

// The Excel export of the Call Recordings screen: one row per recording, for exactly the filters (or the ticked recordings) the screen had. Audio is never embedded.

export interface RecordingExcelRow {
  callAt: Date;
  leadNumber: string;
  customerName: string;
  mobile: string | null;
  telecaller: string;
  products: string;
  leadStatus: string;
  outcome: string;
  durationSeconds: number | null;
  duration: string;
  recordingAvailable: string;
}

const clock = (s: number | null) => (s === null ? "" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function toRecordingExcelRow(i: CallRecordingItem): RecordingExcelRow {
  return {
    callAt: i.callAt,
    leadNumber: i.leadNumber,
    customerName: i.customerName,
    mobile: i.mobile,
    telecaller: i.telecaller.name,
    products: i.products.join(", "),
    leadStatus: titleCase(i.leadStatus),
    outcome: i.outcome,
    durationSeconds: i.durationSeconds,
    duration: clock(i.durationSeconds),
    recordingAvailable: i.playUrl ? "Yes" : "No",
  };
}

export const RECORDINGS_LAYOUT: ExcelLayout<RecordingExcelRow> = {
  sheetName: "Call recordings",
  title: "Call recordings export",
  columns: [
    { header: "Call date & time (IST)", key: "callAt", width: 22 },
    { header: "Lead ID", key: "leadNumber", width: 18 },
    { header: "Customer name", key: "customerName", width: 24 },
    { header: "Mobile number", key: "mobile", width: 16 },
    { header: "Telecaller", key: "telecaller", width: 22 },
    { header: "Product", key: "products", width: 44 },
    { header: "Lead status", key: "leadStatus", width: 16 },
    { header: "Call outcome", key: "outcome", width: 24 },
    { header: "Duration (seconds)", key: "durationSeconds", width: 18 },
    { header: "Duration (m:ss)", key: "duration", width: 14 },
    { header: "Recording available", key: "recordingAvailable", width: 20 },
  ],
  cell: (row, key) => {
    const v = row[key as keyof RecordingExcelRow];
    return v instanceof Date ? istText(v) : (v as string | number | null);
  },
  fileName: (job) => `call-recordings_${job.fromDay}_to_${job.toDay}.xlsx`,
};

const PAGE = 1000;

/** The recordings a filter matches, read in bounded pages (never the whole result at once). */
export class CallRecordingsExcelSource implements ExcelSource<RecordingExcelRow> {
  constructor(
    private readonly service: CallRecordingsService,
    private readonly user: AuthUser,
    private readonly filters: CallRecordingFilters,
  ) {}

  count(): Promise<number> {
    return this.service.count(this.user, this.filters);
  }

  async *pages(): AsyncGenerator<RecordingExcelRow[]> {
    for (let skip = 0; ; skip += PAGE) {
      const rows = await this.service.page(this.user, this.filters, skip, PAGE);
      if (rows.length === 0) return;
      yield rows.map(toRecordingExcelRow);
      if (rows.length < PAGE) return;
    }
  }
}
