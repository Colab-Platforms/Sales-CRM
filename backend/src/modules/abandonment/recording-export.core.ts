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

// The export engine. It knows nothing about Prisma, Express or pg-boss: it works against small interfaces (a repository, a blob store, a fetcher), so the same code runs in
// production (Postgres + the real recording provider) and in the large-export tests (in-memory fakes, or the isolated database with mocked recordings).
//
// ZIP design:
//  - Items (one per recording to include) are written to the repository when the job is created, each with its final file name. The engine only ever walks them in order.
//  - Recordings are downloaded through an ordered sliding window: `concurrency` downloads are always in flight (a new one starts the moment a slot frees up), results are WRITTEN to
//    the ZIP strictly in order. At most `concurrency` recordings (each size-capped) exist in memory at any moment, whatever the export size.
//  - Every `checkpointEvery` items the blob is flushed and the finished items are recorded with their offset / crc / size. A crash or restart resumes from the last checkpoint and
//    never downloads a recording that is already inside the ZIP; a retry of failed recordings appends only those and rewrites just the end of the archive (summary + central directory).
//  - A problem that is the SERVER'S (database blip, network reset, storage hiccup) never fails the job: it is retried in place, and if it persists the job goes back to the queue
//    (up to MAX_ATTEMPTS) and resumes. Only deterministic problems (too large, nothing downloadable) end the job as FAILED.

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
  kind?: "ZIP" | "EXCEL";
  fromDay: string;
  toDay: string;
  status: JobStatus;
  total: number;
  duplicates: number;
  createdAt: Date;
  filters?: unknown;
  createdById?: string;
  role?: string;
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
  /** Progress for exports without per-item rows (Excel). Returns false when the job no longer exists. */
  progress(jobId: string, patch: { total?: number; processed: number; failed?: number; dataEnd?: number }): Promise<boolean>;
  heartbeat(jobId: string): Promise<void>;
  /** Re-reads the recordings' current links from the call records - one query for a whole batch of calls, never one per recording. */
  sources(callIds: string[]): Promise<Map<string, RecordingSource>>;
  finish(jobId: string, patch: { status: "COMPLETED" | "FAILED"; sizeBytes?: number; dataEnd?: number; fileName?: string; errorMessage?: string | null }): Promise<void>;
  /** A server-side problem interrupted the run: puts the job back in the queue to resume ("requeued"), or ends it as FAILED once it has used up its attempts. */
  release(jobId: string, message: string, maxAttempts: number): Promise<"requeued" | "failed">;
}

export interface BlobWriter {
  /** Total bytes in the blob so far (including anything buffered). */
  readonly offset: number;
  write(chunk: Buffer): Promise<void>;
  /** Makes everything written so far durable. */
  flush(): Promise<void>;
}

export interface BlobStore {
  /** Opens the job's file for appending at `offset`: bytes beyond it (a partial entry, an old summary/central directory) are discarded. */
  openWriter(jobId: string, offset: number): Promise<BlobWriter>;
}

export interface RunOptions {
  concurrency: number;
  checkpointEvery: number;
  maxZipBytes: number;
  /** An Excel sheet holds at most 1,048,576 rows; an export stops before that rather than producing a broken file. */
  maxRows: number;
  staleMs: number;
  /** A job interrupted by a server-side problem is re-queued this many times before it is marked FAILED. */
  maxAttempts: number;
  /** Retries of one database / storage call before the problem counts as an interruption. */
  dbRetries: number;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log?: (message: string) => void;
}

export const DEFAULT_RUN_OPTIONS: Omit<RunOptions, "now" | "sleep"> = { concurrency: 6, checkpointEvery: 25, maxZipBytes: 2048 * 1024 * 1024, maxRows: 1_000_000, staleMs: 60_000, maxAttempts: 5, dbRetries: 4 };
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** "retry" = a server-side problem interrupted the run; the job is back in the queue and will resume. */
export type RunOutcome = "completed" | "failed" | "skipped" | "retry";

class ExportAbort extends Error {}
/** A deterministic problem: re-running cannot help, so the job fails instead of being retried. */
export class FatalExportError extends Error {}

export function reasonOf(error: unknown): string {
  if (error instanceof PermanentRecordingError) return error.message.slice(0, 190);
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "download timed out";
    return error.message.slice(0, 190);
  }
  return "download failed";
}

/** Runs a database / storage call, retrying a transient failure with backoff so a blip never interrupts a long export. */
export async function retryTransient<T>(fn: () => Promise<T>, opts: Pick<RunOptions, "dbRetries" | "sleep" | "log">, label: string): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= opts.dbRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ExportAbort || error instanceof FatalExportError) throw error;
      last = error;
      opts.log?.(`${label} failed (attempt ${attempt}/${opts.dbRetries}): ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
      if (attempt < opts.dbRetries) await opts.sleep(Math.min(250 * 2 ** (attempt - 1), 4000));
    }
  }
  throw last;
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

const SOURCE_BATCH = 200;

type Deps = { repo: ExportRepo; store: BlobStore; fetchFile: RecordingFetcher };

export function resolveOptions(partial: Partial<RunOptions> = {}): RunOptions {
  return { ...DEFAULT_RUN_OPTIONS, now: () => new Date(), sleep: realSleep, ...partial };
}

/** Shared by the ZIP and Excel runners: the heartbeat timer and the outcome of an error. */
export async function guardedRun(repo: ExportRepo, jobId: string, opts: RunOptions, body: () => Promise<RunOutcome>): Promise<RunOutcome> {
  const beat = setInterval(() => void repo.heartbeat(jobId).catch(() => undefined), 20_000);
  beat.unref?.();
  try {
    return await body();
  } catch (error) {
    if (error instanceof ExportAbort) return "skipped";
    const message = (error instanceof Error ? error.message : "The export failed.").slice(0, 300);
    opts.log?.(`export ${jobId} interrupted: ${error instanceof Error ? (error.stack ?? error.message).slice(0, 600) : "unknown"}`);
    try {
      if (error instanceof FatalExportError) {
        await retryTransient(() => repo.finish(jobId, { status: "FAILED", errorMessage: message }), opts, "finish");
        return "failed";
      }
      // A server-side problem (database, network, storage): never the job's fault. Back to the queue to resume, up to maxAttempts.
      const result = await retryTransient(() => repo.release(jobId, message, opts.maxAttempts), opts, "release");
      return result === "requeued" ? "retry" : "failed";
    } catch {
      // Even recording the interruption failed: leave the job as it is. Its heartbeat goes stale and maintenance re-queues it.
      return "retry";
    }
  } finally {
    clearInterval(beat);
  }
}

/** The ZIP of recordings: runs (or resumes) one export job to the end. */
export async function runExport(deps: Deps, jobId: string, partial: Partial<RunOptions> = {}): Promise<RunOutcome> {
  const opts = resolveOptions(partial);
  const { repo, store, fetchFile } = deps;
  const job = await repo.claim(jobId, opts.staleMs);
  if (!job) return "skipped";

  return guardedRun(repo, jobId, opts, async () => {
    const all = await retryTransient(() => repo.items(jobId), opts, "load items");
    const dataEnd = all.filter((i) => i.status === "DONE").reduce((max, i) => Math.max(max, i.endOffset ?? 0), 0);
    const writer = await retryTransient(() => store.openWriter(jobId, dataEnd), opts, "open storage");
    const pending = all.filter((i) => i.status === "PENDING");
    const startedAt = opts.now();

    let unsaved: ItemResult[] = [];
    const checkpoint = async () => {
      const batch = unsaved;
      await retryTransient(() => writer.flush(), opts, "flush storage");
      const alive = await retryTransient(() => repo.checkpoint(jobId, batch, writer.offset), opts, "checkpoint");
      unsaved = [];
      if (!alive) throw new ExportAbort("job no longer exists");
    };

    type Fetched = { item: ExportItem; data?: Buffer; fail?: string };
    // Links are looked up SOURCE_BATCH at a time (one query per batch), lazily and once per batch, however many downloads are in flight.
    const batches = new Map<number, Promise<Map<string, RecordingSource>>>();
    const sourceOf = async (index: number, item: ExportItem): Promise<RecordingSource | null> => {
      const b = Math.floor(index / SOURCE_BATCH);
      let batch = batches.get(b);
      if (!batch) {
        batch = retryTransient(() => repo.sources(pending.slice(b * SOURCE_BATCH, (b + 1) * SOURCE_BATCH).map((i) => i.callId)), opts, "load recording links");
        batches.set(b, batch);
        batches.delete(b - 2); // the finished batch behind the window is not kept
      }
      return (await batch).get(item.callId) ?? null;
    };
    const fetchOne = async (item: ExportItem, index: number): Promise<Fetched> => {
      try {
        const source = await sourceOf(index, item);
        const why = source ? unavailableReason(source, opts.now()) : "call record not found";
        if (why) return { item, fail: why };
        return { item, data: (await fetchFile(source!.recordingUrl!)).data };
      } catch (error) {
        return { item, fail: reasonOf(error) };
      }
    };

    // Ordered sliding window: keep `concurrency` downloads in flight, consume them strictly in order. Memory is bounded by the window, never by the export.
    const window: Promise<Fetched>[] = [];
    let next = 0;
    const fill = () => {
      while (window.length < opts.concurrency && next < pending.length) {
        window.push(fetchOne(pending[next]!, next));
        next++;
      }
    };
    fill();
    while (window.length > 0) {
      const r = await window.shift()!;
      fill(); // the slot is free again before this one is written
      if (!r.data) {
        unsaved.push({ seq: r.item.seq, status: "FAILED", reason: r.fail ?? "download failed" });
      } else {
        const { header, crc } = zipLocalHeader(r.item.fileName, r.data, startedAt);
        const localOffset = writer.offset;
        await writer.write(header);
        await writer.write(r.data);
        unsaved.push({ seq: r.item.seq, status: "DONE", crc32: crc, size: r.data.length, localOffset, endOffset: writer.offset });
        if (writer.offset > opts.maxZipBytes) throw new FatalExportError(`The ZIP would be larger than the ${Math.round(opts.maxZipBytes / 1024 / 1024)} MB limit. Choose a shorter date range.`);
      }
      if (unsaved.length >= opts.checkpointEvery) await checkpoint();
    }
    await checkpoint();

    const finalItems = await retryTransient(() => repo.items(jobId), opts, "load items");
    const done = finalItems.filter((i) => i.status === "DONE").sort((a, b) => (a.localOffset ?? 0) - (b.localOffset ?? 0));
    if (done.length === 0) {
      await retryTransient(() => repo.finish(jobId, { status: "FAILED", errorMessage: `None of the ${finalItems.length} recordings could be downloaded. You can retry the export.` }), opts, "finish");
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
    await retryTransient(() => writer.flush(), opts, "flush storage");

    const fileName = `recordings_${job.fromDay}_to_${job.toDay}.zip`;
    await retryTransient(() => repo.finish(jobId, { status: "COMPLETED", sizeBytes: writer.offset, dataEnd: audioEnd, fileName, errorMessage: null }), opts, "finish");
    return "completed";
  });
}
