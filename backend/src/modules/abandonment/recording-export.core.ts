import { Buffer } from "node:buffer";
import {
  PermanentRecordingError,
  recordingStamp,
  unavailableReason,
  zipCentralDirectory,
  zipLocalHeader,
  type RecordingFetcher,
  type ZipEntryInfo,
} from "./abandonment.recordings.js";

// The export engine. It knows nothing about Prisma, Express or pg-boss: it works against three small interfaces (a repository, a blob store, a fetcher), so the
// same code runs in production (Postgres + the real recording provider) and in the large-export tests (in-memory fakes).
//
// Design:
//  - Items (one per recording to include) are written to the repository when the job is created, each with its final file name. The engine only ever walks them in order.
//  - Recordings are downloaded `concurrency` at a time (each held in memory only until it is written, and capped in size), but WRITTEN to the ZIP strictly in order, one entry after
//    another, so the byte layout is deterministic and a resume can continue exactly where the last checkpoint ended.
//  - Every `checkpointEvery` items the blob is flushed and the finished items are recorded with their offset / crc / size. A crash or restart resumes from the last checkpoint and never
//    downloads a recording that is already inside the ZIP; a retry of failed recordings appends only those and rewrites just the end of the archive (summary + central directory).
//  - The central directory is built from the recorded items, so nothing about the ZIP is ever held in memory except the entries' metadata.

export type ItemStatus = "PENDING" | "DONE" | "FAILED";
export type JobStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface ExportItem {
  seq: number;
  callId: string;
  fileName: string;
  status: ItemStatus;
  reason: string | null;
  crc32: number | null;
  size: number | null;
  localOffset: number | null;
  endOffset: number | null;
}

export interface ExportJobRow {
  id: string;
  fromDay: string;
  toDay: string;
  status: JobStatus;
  total: number;
  duplicates: number;
  createdAt: Date;
}

export interface ItemResult {
  seq: number;
  status: "DONE" | "FAILED";
  reason?: string | null;
  crc32?: number;
  size?: number;
  localOffset?: number;
  endOffset?: number;
}

export interface RecordingSource {
  recordingUrl: string | null;
  expiresAt: Date | null;
}

export interface ExportRepo {
  /** Atomically takes the job (QUEUED, or PROCESSING with a stale heartbeat); null when someone else has it, it is gone, or it is already finished. */
  claim(jobId: string, staleMs: number): Promise<ExportJobRow | null>;
  items(jobId: string): Promise<ExportItem[]>;
  /** Records finished items and refreshes the job's counters, data-end offset and heartbeat. Returns false when the job no longer exists (deleted / expired). */
  checkpoint(jobId: string, results: ItemResult[], dataEnd: number): Promise<boolean>;
  heartbeat(jobId: string): Promise<void>;
  /** Re-reads the recording's current link from the call record. */
  source(callId: string): Promise<RecordingSource | null>;
  finish(jobId: string, patch: { status: "COMPLETED" | "FAILED"; sizeBytes?: number; dataEnd?: number; fileName?: string; errorMessage?: string | null }): Promise<void>;
}

export interface BlobWriter {
  /** Total bytes in the blob so far (including anything buffered). */
  readonly offset: number;
  write(chunk: Buffer): Promise<void>;
  /** Makes everything written so far durable. */
  flush(): Promise<void>;
}

export interface BlobStore {
  /** Opens the job's ZIP for appending at `offset`: bytes beyond it (a partial entry, an old summary/central directory) are discarded. */
  openWriter(jobId: string, offset: number): Promise<BlobWriter>;
}

export interface RunOptions {
  concurrency: number;
  checkpointEvery: number;
  maxZipBytes: number;
  staleMs: number;
  now: () => Date;
  log?: (message: string) => void;
}

export const DEFAULT_RUN_OPTIONS: Omit<RunOptions, "now"> = { concurrency: 3, checkpointEvery: 25, maxZipBytes: 2048 * 1024 * 1024, staleMs: 5 * 60_000 };

export type RunOutcome = "completed" | "failed" | "skipped";

class ExportAbort extends Error {}

export function reasonOf(error: unknown): string {
  if (error instanceof PermanentRecordingError) return error.message.slice(0, 190);
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "download timed out";
    return error.message.slice(0, 190);
  }
  return "download failed";
}

/** "LEAD-1_Rahul_..._ab12cd34.mp3" for the ZIP, with a numeric suffix when two names would collide. */
export function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = base.replace(/(\.\w+)?$/, `_${n}$1`);
  taken.add(name);
  return name;
}

function summaryText(job: ExportJobRow, items: ExportItem[], now: Date): string {
  const done = items.filter((i) => i.status === "DONE");
  const failed = items.filter((i) => i.status === "FAILED");
  const lines = [
    `Call recordings ${job.fromDay} to ${job.toDay}`,
    `Generated: ${recordingStamp(now)} IST`,
    `Total recordings: ${items.length}`,
    `Downloaded successfully: ${done.length}`,
    `Failed / unavailable: ${failed.length}`,
    `Duplicates left out: ${job.duplicates}`,
  ];
  if (failed.length > 0) {
    lines.push("", "Failed / unavailable recordings:");
    for (const i of failed) lines.push(`- ${i.fileName} (${i.reason ?? "unavailable"})`);
  }
  return lines.join("\n") + "\n";
}

/** Runs (or resumes) one export job to the end. Never throws for a recording-level problem; a job-level problem ends the job as FAILED with a message the user can read. */
export async function runExport(deps: { repo: ExportRepo; store: BlobStore; fetchFile: RecordingFetcher }, jobId: string, partial: Partial<RunOptions> = {}): Promise<RunOutcome> {
  const opts: RunOptions = { ...DEFAULT_RUN_OPTIONS, now: () => new Date(), ...partial };
  const { repo, store, fetchFile } = deps;
  const job = await repo.claim(jobId, opts.staleMs);
  if (!job) return "skipped";

  const beat = setInterval(() => void repo.heartbeat(jobId).catch(() => undefined), 20_000);
  beat.unref?.();
  try {
    const all = await repo.items(jobId);
    const dataEnd = all.filter((i) => i.status === "DONE").reduce((max, i) => Math.max(max, i.endOffset ?? 0), 0);
    const writer = await store.openWriter(jobId, dataEnd);
    const pending = all.filter((i) => i.status === "PENDING");
    const startedAt = opts.now();

    let unsaved: ItemResult[] = [];
    const checkpoint = async () => {
      await writer.flush();
      const alive = await repo.checkpoint(jobId, unsaved, writer.offset);
      unsaved = [];
      if (!alive) throw new ExportAbort("job no longer exists");
    };

    for (let i = 0; i < pending.length; i += opts.concurrency) {
      const window = pending.slice(i, i + opts.concurrency);
      const fetched = await Promise.all(
        window.map(async (item): Promise<{ item: ExportItem; data?: Buffer; fail?: string }> => {
          try {
            const source = await repo.source(item.callId);
            const why = source ? unavailableReason(source, opts.now()) : "call record not found";
            if (why) return { item, fail: why };
            return { item, data: (await fetchFile(source!.recordingUrl!)).data };
          } catch (error) {
            return { item, fail: reasonOf(error) };
          }
        }),
      );
      // Written strictly in order: the layout never depends on which download finished first.
      for (const r of fetched) {
        if (!r.data) {
          unsaved.push({ seq: r.item.seq, status: "FAILED", reason: r.fail ?? "download failed" });
          continue;
        }
        const { header, crc } = zipLocalHeader(r.item.fileName, r.data, startedAt);
        const localOffset = writer.offset;
        await writer.write(header);
        await writer.write(r.data);
        unsaved.push({ seq: r.item.seq, status: "DONE", crc32: crc, size: r.data.length, localOffset, endOffset: writer.offset });
        if (writer.offset > opts.maxZipBytes) throw new Error(`The ZIP would be larger than the ${Math.round(opts.maxZipBytes / 1024 / 1024)} MB limit. Choose a shorter date range.`);
      }
      if (unsaved.length >= opts.checkpointEvery) await checkpoint();
    }
    await checkpoint();

    const finalItems = await repo.items(jobId);
    const done = finalItems.filter((i) => i.status === "DONE").sort((a, b) => (a.localOffset ?? 0) - (b.localOffset ?? 0));
    if (done.length === 0) {
      await repo.finish(jobId, { status: "FAILED", errorMessage: `None of the ${finalItems.length} recordings could be downloaded. You can retry the export.` });
      return "failed";
    }

    // Finish the archive: the summary entry, then the central directory.
    const audioEnd = writer.offset;
    const summary = Buffer.from(summaryText(job, finalItems, opts.now()), "utf8");
    const { header, crc } = zipLocalHeader("_summary.txt", summary, startedAt);
    const entries: ZipEntryInfo[] = done.map((i) => ({ name: i.fileName, crc: i.crc32!, size: i.size!, localOffset: i.localOffset! }));
    entries.push({ name: "_summary.txt", crc, size: summary.length, localOffset: audioEnd });
    await writer.write(header);
    await writer.write(summary);
    await writer.write(zipCentralDirectory(entries, writer.offset, startedAt));
    await writer.flush();

    const fileName = `recordings_${job.fromDay}_to_${job.toDay}.zip`;
    await repo.finish(jobId, { status: "COMPLETED", sizeBytes: writer.offset, dataEnd: audioEnd, fileName, errorMessage: null });
    return "completed";
  } catch (error) {
    if (error instanceof ExportAbort) return "skipped";
    opts.log?.(`export ${jobId} failed: ${error instanceof Error ? error.message : "unknown"}`);
    await repo.finish(jobId, { status: "FAILED", errorMessage: (error instanceof Error ? error.message : "The export failed.").slice(0, 300) }).catch(() => undefined);
    return "failed";
  } finally {
    clearInterval(beat);
  }
}
