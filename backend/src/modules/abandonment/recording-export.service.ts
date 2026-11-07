import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Response } from "express";
import { prisma } from "@/lib/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { getQueue } from "@/lib/queue.js";
import { logger } from "@/utils/logger.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { canAccessRecordings } from "./abandonment.filters.js";
import { AbandonmentRecordingsService, fetchRecordingFile, recordingRangeBounds, type RecordingFetcher, type RecordingRange } from "./abandonment.recordings.js";
import { DEFAULT_RUN_OPTIONS, runExport, type BlobStore, type BlobWriter, type ExportItem, type ExportJobRow, type ExportRepo, type ItemResult, type JobStatus, type RunOutcome } from "./recording-export.core.js";
import { runExcelExport } from "./recording-export.excel.js";
import { PrismaExcelSource, describeSelection, planZipItems, sanitizeExportFilters } from "./recording-export.sources.js";

export type ExportKind = "ZIP" | "EXCEL";

// Background ZIP exports of call recordings.
//  - Worker:  the app's existing pg-boss queue (same Postgres, no new service). One export per instance at a time by default (RECORDING_EXPORT_WORKERS).
//  - Storage: the finished ZIP is kept in Postgres as 4 MB chunks (recording_export_chunks). There is no object store provisioned, and local disk does not survive a restart or a
//             second instance. Chunks are written and read one at a time, so neither building nor downloading ever holds the ZIP in memory.
//  - Cleanup: jobs, items and chunks are deleted once expires_at passes (RECORDING_EXPORT_RETENTION_HOURS, default 24).

/**
 * The pg-boss queue the exports use. Every process connected to the same database that listens on the same queue name can pick up a job, so a developer machine that shares a database
 * with another deployment sets RECORDING_EXPORT_QUEUE to its own name: only that machine then runs its exports. Default: "recording-export".
 */
export function exportQueueName(env: Record<string, string | undefined> = process.env): string {
  const name = (env.RECORDING_EXPORT_QUEUE ?? "").trim();
  return /^[A-Za-z0-9_.-]{1,60}$/.test(name) ? name : "recording-export";
}
const CHUNK_BYTES = 4 * 1024 * 1024;
const ACTIVE: JobStatus[] = ["QUEUED", "PROCESSING"];
const MAX_ACTIVE_PER_USER = 2;
const MAX_ACTIVE_TOTAL = 10;
const CLEANUP_TICK_MS = 30_000;
/** A QUEUED export nobody has picked up for this long (the queue or worker was down) is handed to the queue again. */
const QUEUED_STUCK_MS = 5 * 60_000;
const RETRY_DELAY_SECONDS = 30;
const DOWNLOAD_LINK_SECONDS = 120;

function signDownload(jobId: string, userId: string, exp: number): string {
  // Its own HMAC purpose, never a login token: this value can do nothing except fetch this one file until it expires.
  return createHmac("sha256", `${process.env.JWT_SECRET ?? ""}:recording-export-download`).update(`${jobId}.${userId}.${exp}`).digest("base64url");
}

const envNumber = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const exportConfig = {
  retentionHours: () => envNumber("RECORDING_EXPORT_RETENTION_HOURS", 24),
  maxItems: () => envNumber("RECORDING_EXPORT_MAX_ITEMS", 20_000),
  maxZipBytes: () => envNumber("RECORDING_EXPORT_MAX_ZIP_MB", 2048) * 1024 * 1024,
  /** Recordings downloaded at once, per running export (default 6, at most 16): the provider-friendly knob. */
  concurrency: () => Math.min(envNumber("RECORDING_EXPORT_CONCURRENCY", DEFAULT_RUN_OPTIONS.concurrency), 16),
  /** How many finished recordings are saved at once (default 25): a restart repeats at most this many downloads. */
  checkpointEvery: () => Math.min(envNumber("RECORDING_EXPORT_BATCH_SIZE", DEFAULT_RUN_OPTIONS.checkpointEvery), 200),
  maxRows: () => Math.min(envNumber("RECORDING_EXPORT_MAX_EXCEL_ROWS", DEFAULT_RUN_OPTIONS.maxRows), 1_048_000),
  workers: () => Math.min(envNumber("RECORDING_EXPORT_WORKERS", 1), 4),
};

type Db = typeof prisma;

// ---------- Prisma implementations of the engine's interfaces ----------

export class PrismaExportRepo implements ExportRepo {
  constructor(private readonly db: Db = prisma) {}

  async claim(jobId: string, staleMs: number): Promise<ExportJobRow | null> {
    const now = new Date();
    const claimed = await this.db.recordingExportJob.updateMany({
      where: { id: jobId, expiresAt: { gt: now }, OR: [{ status: "QUEUED" }, { status: "PROCESSING", heartbeatAt: { lt: new Date(now.getTime() - staleMs) } }] },
      data: { status: "PROCESSING", heartbeatAt: now, startedAt: now, finishedAt: null, errorMessage: null, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return null;
    const job = await this.db.recordingExportJob.findUnique({ where: { id: jobId } });
    return job ? { id: job.id, kind: job.kind as ExportKind, fromDay: job.fromDay, toDay: job.toDay, status: job.status as JobStatus, total: job.total, duplicates: job.duplicates, createdAt: job.createdAt, filters: job.filters, createdById: job.createdById, role: job.role } : null;
  }

  async progress(jobId: string, patch: { total?: number; processed: number; failed?: number; dataEnd?: number }): Promise<boolean> {
    const updated = await this.db.recordingExportJob.updateMany({
      where: { id: jobId },
      data: { ...(patch.total !== undefined ? { total: patch.total } : {}), processed: patch.processed, ...(patch.failed !== undefined ? { failed: patch.failed } : {}), ...(patch.dataEnd !== undefined ? { dataEnd: patch.dataEnd } : {}), heartbeatAt: new Date() },
    });
    return updated.count === 1;
  }

  async release(jobId: string, message: string, maxAttempts: number): Promise<"requeued" | "failed"> {
    const job = await this.db.recordingExportJob.findUnique({ where: { id: jobId }, select: { attempts: true } });
    if (!job) return "failed";
    if (job.attempts >= maxAttempts) {
      await this.finish(jobId, { status: "FAILED", errorMessage: `The export was interrupted ${job.attempts} times and gave up: ${message}`.slice(0, 300) });
      return "failed";
    }
    // Back to the queue with its progress intact; the next run resumes from the last checkpoint.
    await this.db.recordingExportJob.updateMany({ where: { id: jobId }, data: { status: "QUEUED", heartbeatAt: new Date(), errorMessage: `Temporary problem, resuming automatically: ${message}`.slice(0, 300) } });
    return "requeued";
  }

  async items(jobId: string): Promise<ExportItem[]> {
    const rows = await this.db.recordingExportItem.findMany({ where: { jobId }, orderBy: { seq: "asc" } });
    const n = (v: bigint | null) => (v === null ? null : Number(v));
    return rows.map((r) => ({ seq: r.seq, callId: r.callId, fileName: r.fileName, status: r.status as ExportItem["status"], reason: r.reason, crc32: n(r.crc32), size: n(r.size), localOffset: n(r.localOffset), endOffset: n(r.endOffset) }));
  }

  async checkpoint(jobId: string, results: ItemResult[], dataEnd: number): Promise<boolean> {
    if (results.length > 0) {
      // ONE statement for the whole batch (not one round trip per recording): the difference between ~50 and several hundred recordings a second against a remote database.
      const values = results.map((r) => Prisma.sql`(${r.seq}::int, ${r.status}::text, ${r.reason ?? null}::text, ${r.crc32 ?? null}::bigint, ${r.size ?? null}::bigint, ${r.localOffset ?? null}::bigint, ${r.endOffset ?? null}::bigint)`);
      await this.db.$executeRaw(Prisma.sql`
        UPDATE recording_export_items AS i
        SET status = v.status, reason = v.reason, crc32 = v.crc32, size = v.size, local_offset = v.local_offset, end_offset = v.end_offset
        FROM (VALUES ${Prisma.join(values)}) AS v(seq, status, reason, crc32, size, local_offset, end_offset)
        WHERE i.job_id = ${jobId}::uuid AND i.seq = v.seq`);
    }
    const counts = await this.db.recordingExportItem.groupBy({ by: ["status"], where: { jobId }, _count: { _all: true } });
    const of = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
    const updated = await this.db.recordingExportJob.updateMany({ where: { id: jobId }, data: { processed: of("DONE"), failed: of("FAILED"), dataEnd, heartbeatAt: new Date() } });
    return updated.count === 1;
  }

  async heartbeat(jobId: string): Promise<void> {
    await this.db.recordingExportJob.updateMany({ where: { id: jobId, status: "PROCESSING" }, data: { heartbeatAt: new Date() } });
  }

  async sources(callIds: string[]) {
    const rows = callIds.length === 0 ? [] : await this.db.callRecording.findMany({ where: { callId: { in: callIds } }, select: { callId: true, recordingUrl: true, expiresAt: true } });
    return new Map(rows.map((r) => [r.callId, { recordingUrl: r.recordingUrl, expiresAt: r.expiresAt }]));
  }

  async finish(jobId: string, patch: { status: "COMPLETED" | "FAILED"; sizeBytes?: number; dataEnd?: number; fileName?: string; errorMessage?: string | null }): Promise<void> {
    await this.db.recordingExportJob.updateMany({
      where: { id: jobId },
      data: {
        status: patch.status,
        finishedAt: new Date(),
        errorMessage: patch.errorMessage ?? null,
        ...(patch.sizeBytes !== undefined ? { sizeBytes: patch.sizeBytes } : {}),
        ...(patch.dataEnd !== undefined ? { dataEnd: patch.dataEnd } : {}),
        ...(patch.fileName ? { fileName: patch.fileName } : {}),
      },
    });
  }
}

/** The ZIP as fixed-size chunks in Postgres. Chunk n holds bytes [n*CHUNK, (n+1)*CHUNK). */
export class PostgresBlobStore implements BlobStore {
  constructor(private readonly db: Db = prisma, private readonly chunkBytes: number = CHUNK_BYTES) {}

  async openWriter(jobId: string, offset: number): Promise<BlobWriter> {
    const ch = this.chunkBytes;
    const db = this.db;
    let seq = Math.floor(offset / ch);
    const rem = offset % ch;
    await db.recordingExportChunk.deleteMany({ where: { jobId, seq: { gt: seq } } });
    let parts: Buffer[] = [];
    let length = 0;
    if (rem > 0) {
      const chunk = await db.recordingExportChunk.findUnique({ where: { jobId_seq: { jobId, seq } } });
      if (!chunk || chunk.data.length < rem) throw new Error("Stored export data is incomplete. Start a new export.");
      parts = [Buffer.from(chunk.data.subarray(0, rem))];
      length = rem;
    } else {
      await db.recordingExportChunk.deleteMany({ where: { jobId, seq } });
    }
    const save = (index: number, data: Buffer) =>
      db.recordingExportChunk.upsert({ where: { jobId_seq: { jobId, seq: index } }, create: { jobId, seq: index, data: Uint8Array.from(data) }, update: { data: Uint8Array.from(data) } });
    return {
      get offset() {
        return seq * ch + length;
      },
      async write(chunk: Buffer) {
        parts.push(chunk);
        length += chunk.length;
        if (length >= ch) {
          let all = Buffer.concat(parts);
          while (all.length >= ch) {
            await save(seq, all.subarray(0, ch));
            seq++;
            all = all.subarray(ch);
          }
          parts = all.length > 0 ? [Buffer.from(all)] : [];
          length = all.length;
        }
      },
      async flush() {
        if (length === 0) return;
        const all = Buffer.concat(parts);
        parts = [all];
        await save(seq, all);
      },
    };
  }

  /** Streams the stored ZIP, one chunk in memory at a time. */
  stream(jobId: string, sizeBytes: number): Readable {
    const ch = this.chunkBytes;
    const db = this.db;
    async function* chunks() {
      for (let seq = 0; seq * ch < sizeBytes; seq++) {
        const row = await db.recordingExportChunk.findUnique({ where: { jobId_seq: { jobId, seq } } });
        if (!row) throw new Error("export data is missing");
        yield Buffer.from(row.data);
      }
    }
    return Readable.from(chunks());
  }
}

// ---------- the service ----------

export interface ExportStatusDto {
  id: string;
  kind: ExportKind;
  status: JobStatus;
  from: string;
  to: string;
  total: number;
  processed: number;
  failed: number;
  remaining: number;
  percent: number;
  duplicates: number;
  sizeBytes: number;
  fileName: string | null;
  errorMessage: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  expiresAt: Date;
  canDownload: boolean;
  /** "IDS": exactly the leads that were ticked; "MATCHING": every lead the list filters matched; null: the date range. */
  selection: "IDS" | "MATCHING" | null;
  selectedCount: number | null;
  /** The export applies filters (salesperson, lead status, search...) on top of its date range. */
  filtered: boolean;
  /** PROCESSING with no sign of life for a while (the worker restarted): it is picked up again automatically; shown so the page never claims live progress that is not happening. */
  stalled: boolean;
  /** How many times a server-side problem has interrupted this export (it resumes each time). */
  attempts: number;
  /** FAILED, or finished with some failed recordings: a retry downloads only the ones still missing. */
  canRetry: boolean;
  reused?: boolean;
}

type JobRecord = NonNullable<Awaited<ReturnType<Db["recordingExportJob"]["findUnique"]>>>;

export function toStatusDto(job: JobRecord, now: Date = new Date()): ExportStatusDto {
  const done = job.processed + job.failed;
  const expired = job.expiresAt.getTime() <= now.getTime();
  const status = job.status as JobStatus;
  const beat = job.heartbeatAt?.getTime() ?? job.createdAt.getTime();
  const stalled = (status === "PROCESSING" && now.getTime() - beat > DEFAULT_RUN_OPTIONS.staleMs) || (status === "QUEUED" && now.getTime() - beat > QUEUED_STUCK_MS);
  return {
    id: job.id,
    kind: (job.kind === "EXCEL" ? "EXCEL" : "ZIP") as ExportKind,
    stalled,
    ...describeSelection(job.filters),
    attempts: job.attempts,
    status,
    from: job.fromDay,
    to: job.toDay,
    total: job.total,
    processed: job.processed,
    failed: job.failed,
    remaining: Math.max(job.total - done, 0),
    percent: job.total === 0 ? 100 : status === "COMPLETED" ? 100 : Math.min(Math.floor((done / job.total) * 100), 99),
    duplicates: job.duplicates,
    sizeBytes: Number(job.sizeBytes),
    fileName: job.fileName,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    expiresAt: job.expiresAt,
    canDownload: status === "COMPLETED" && !expired,
    canRetry: !expired && (status === "FAILED" || (status === "COMPLETED" && job.failed > 0)),
  };
}

export class RecordingExportService {
  constructor(
    private readonly db: Db = prisma,
    private readonly recordings: AbandonmentRecordingsService = new AbandonmentRecordingsService(),
    private readonly enqueue: (jobId: string, options?: { delaySeconds?: number }) => Promise<void> = enqueueExport,
    private readonly store: PostgresBlobStore = new PostgresBlobStore(),
  ) {}

  private assertAllowed(user: AuthUser): void {
    if (!canAccessRecordings(user.role)) throw new ApiError("Only admins and managers can export call recordings", STATUS_CODES.FORBIDDEN);
  }

  private async ownJob(user: AuthUser, id: string): Promise<JobRecord> {
    this.assertAllowed(user);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError("Export not found", STATUS_CODES.NOT_FOUND);
    const job = await this.db.recordingExportJob.findUnique({ where: { id } });
    // Someone else's export looks exactly like a missing one.
    if (!job || job.createdById !== user.id || job.expiresAt.getTime() <= Date.now()) throw new ApiError("Export not found or expired", STATUS_CODES.NOT_FOUND);
    return job;
  }

  /** Starts a background export (ZIP of recordings or Excel of leads), or returns the one already running for the same user, kind and date range. */
  async create(user: AuthUser, input: { kind?: ExportKind; from: string; to: string; filters?: unknown }): Promise<ExportStatusDto> {
    this.assertAllowed(user);
    const kind: ExportKind = input.kind === "EXCEL" ? "EXCEL" : "ZIP";
    const range: RecordingRange = { from: input.from, to: input.to };
    recordingRangeBounds(range); // validates the dates
    const filters = kind === "EXCEL" ? sanitizeExportFilters(input.filters) : null;
    const now = new Date();
    const active = await this.db.recordingExportJob.findMany({ where: { status: { in: ACTIVE }, expiresAt: { gt: now } }, select: { id: true, createdById: true, fromDay: true, toDay: true, kind: true, filters: true } });
    const filterKey = JSON.stringify(filters ?? null);
    const same = active.find((j) => j.createdById === user.id && j.kind === kind && j.fromDay === range.from && j.toDay === range.to && JSON.stringify(j.filters ?? null) === filterKey);
    if (same) return { ...toStatusDto(await this.db.recordingExportJob.findUniqueOrThrow({ where: { id: same.id } }), now), reused: true };
    // Limits are per KIND: a lead Excel and a recording ZIP never queue behind (or block) each other.
    if (active.filter((j) => j.createdById === user.id && j.kind === kind).length >= MAX_ACTIVE_PER_USER) throw new ApiError("You already have " + (kind === "EXCEL" ? "Excel" : "ZIP") + " exports running. Wait for one to finish before starting another.", 429);
    if (active.filter((j) => j.kind === kind).length >= MAX_ACTIVE_TOTAL) throw new ApiError("The server is busy with other exports. Please try again in a few minutes.", 429);

    const job = await this.db.recordingExportJob.create({
      data: {
        createdById: user.id,
        role: user.role,
        kind,
        filters: (filters ?? undefined) as Prisma.InputJsonValue | undefined,
        fromDay: range.from,
        toDay: range.to,
        expiresAt: new Date(now.getTime() + exportConfig.retentionHours() * 3_600_000),
      },
    });
    try {
      if (kind === "ZIP") {
        // Chunked planning: the range is read in keyset pages and the item rows are written as they are produced.
        const plan = await planZipItems({ db: this.db, recordings: this.recordings, user, range, jobId: job.id, now, maxItems: exportConfig.maxItems() });
        if (plan.total === 0) throw new ApiError("No recordings found for this date range", STATUS_CODES.NOT_FOUND);
        await this.db.recordingExportJob.update({ where: { id: job.id }, data: { total: plan.total, failed: plan.failed, duplicates: plan.duplicates } });
      } else {
        const total = await new PrismaExcelSource(this.db, user, range, filters).count();
        if (total === 0) throw new ApiError("No abandoned leads found for this date range", STATUS_CODES.NOT_FOUND);
        if (total > exportConfig.maxRows()) throw new ApiError(`${total} leads match, more than one Excel file can hold (${exportConfig.maxRows()}). Choose a shorter date range.`, STATUS_CODES.BAD_REQUEST);
        await this.db.recordingExportJob.update({ where: { id: job.id }, data: { total } });
      }
    } catch (error) {
      // No half-planned job is left behind (its items go with it).
      await this.db.recordingExportJob.delete({ where: { id: job.id } }).catch(() => undefined);
      throw error;
    }
    await this.start(job.id);
    return toStatusDto(await this.db.recordingExportJob.findUniqueOrThrow({ where: { id: job.id } }), now);
  }

  private async start(jobId: string): Promise<void> {
    try {
      await this.enqueue(jobId);
    } catch (error) {
      logger.error(`[recording-export] could not queue job=${jobId}`, error);
      await this.db.recordingExportJob.updateMany({ where: { id: jobId }, data: { status: "FAILED", finishedAt: new Date(), errorMessage: "The export could not be queued. Please retry." } });
    }
  }

  /** The user's recent exports (history), newest first. Also hands a stuck export of theirs back to the queue, so opening the page can never leave one dangling. */
  async list(user: AuthUser): Promise<ExportStatusDto[]> {
    this.assertAllowed(user);
    const now = new Date();
    const jobs = await this.db.recordingExportJob.findMany({ where: { createdById: user.id, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" }, take: 10 });
    if (jobs.some((j) => toStatusDto(j, now).stalled)) void recordingExportMaintenance(this.db, this.enqueue, now, user.id).catch((error) => logger.warn(`[recording-export] heal failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`));
    return jobs.map((j) => toStatusDto(j, now));
  }

  async get(user: AuthUser, id: string): Promise<ExportStatusDto> {
    return toStatusDto(await this.ownJob(user, id));
  }

  /** Re-runs a failed export (or one that finished with failed recordings). Recordings already in the ZIP are NOT downloaded again; an Excel file is rebuilt. */
  async retry(user: AuthUser, id: string): Promise<ExportStatusDto> {
    const job = await this.ownJob(user, id);
    const dto = toStatusDto(job);
    if (ACTIVE.includes(job.status as JobStatus)) return dto;
    if (!dto.canRetry) throw new ApiError("Nothing to retry for this export", STATUS_CODES.BAD_REQUEST);
    if (job.kind === "ZIP") await this.db.recordingExportItem.updateMany({ where: { jobId: id, status: "FAILED" }, data: { status: "PENDING", reason: null } });
    await this.db.recordingExportJob.updateMany({ where: { id }, data: { status: "QUEUED", attempts: 0, errorMessage: null, finishedAt: null, heartbeatAt: new Date() } });
    await this.start(id);
    return toStatusDto(await this.db.recordingExportJob.findUniqueOrThrow({ where: { id } }));
  }

  /** A short-lived link the browser can follow directly, so a large file streams to disk instead of being buffered by the page. Issued only to the export's owner. */
  async downloadLink(user: AuthUser, id: string): Promise<{ url: string; expiresInSeconds: number }> {
    const job = await this.ownJob(user, id);
    if (job.status !== "COMPLETED") throw new ApiError("This export is not ready yet", STATUS_CODES.BAD_REQUEST);
    const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_LINK_SECONDS;
    return { url: `/abandonments/recordings/exports/${id}/file?u=${user.id}&e=${exp}&s=${signDownload(id, user.id, exp)}`, expiresInSeconds: DOWNLOAD_LINK_SECONDS };
  }

  /** Serves the file for a valid link: signature, expiry, ownership and the user's CURRENT role are all checked again. */
  async downloadByLink(id: string, userId: string, exp: number, signature: string, res: Response): Promise<void> {
    const expected = signDownload(id, userId, exp);
    const valid = expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (!valid || !Number.isFinite(exp) || exp * 1000 < Date.now()) throw new ApiError("This download link is invalid or has expired. Request a new one.", STATUS_CODES.FORBIDDEN);
    const owner = await this.db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, username: true } });
    if (!owner) throw new ApiError("This download link is invalid or has expired. Request a new one.", STATUS_CODES.FORBIDDEN);
    await this.download({ id: owner.id, role: owner.role, username: owner.username }, id, res);
  }

  async download(user: AuthUser, id: string, res: Response): Promise<void> {
    const job = await this.ownJob(user, id);
    if (job.status !== "COMPLETED") throw new ApiError("This export is not ready yet", STATUS_CODES.BAD_REQUEST);
    const size = Number(job.sizeBytes);
    const excel = job.kind === "EXCEL";
    res.setHeader("Content-Type", excel ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${job.fileName ?? (excel ? `abandoned-leads_${job.fromDay}_to_${job.toDay}.xlsx` : `recordings_${job.fromDay}_to_${job.toDay}.zip`)}"`);
    res.setHeader("Content-Length", String(size));
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.status(200);
    await pipeline(this.store.stream(id, size), res);
  }
}

// ---------- queue, worker and cleanup ----------

let queueReady: Promise<void> | null = null;
async function ensureQueue(): Promise<void> {
  if (!queueReady) {
    queueReady = getQueue().then(async (boss) => {
      await boss.createQueue(exportQueueName(), { retryLimit: 2, retryBackoff: true });
    });
  }
  return queueReady;
}

export async function enqueueExport(jobId: string, options: { delaySeconds?: number } = {}): Promise<void> {
  await ensureQueue();
  const boss = await getQueue();
  // A long job: the default 15-minute expiry would hand a still-running export to a second worker (the claim in the repo would refuse it, but there is no point).
  await boss.send(exportQueueName(), { jobId }, { expireInSeconds: 6 * 3600, ...(options.delaySeconds ? { startAfter: options.delaySeconds } : {}) });
}

export interface ExportWorkerDeps {
  repo: ExportRepo;
  store: BlobStore;
  fetchFile: RecordingFetcher;
  excelSource: (job: ExportJobRow) => PrismaExcelSource;
  enqueue: (jobId: string, options?: { delaySeconds?: number }) => Promise<void>;
}

/** Exports this process is running right now (so a shutdown can hand them back at once instead of leaving them to be noticed as stale). */
const running = new Set<string>();

/** Called on SIGTERM (a redeploy / restart): puts every export this process was running back in the queue, marked as released, so another instance - or this one after it restarts - resumes it within one maintenance sweep. */
export async function releaseRunningExports(db: Db = prisma): Promise<number> {
  const ids = [...running];
  if (ids.length === 0) return 0;
  const result = await db.recordingExportJob.updateMany({ where: { id: { in: ids }, status: "PROCESSING" }, data: { status: "QUEUED", heartbeatAt: new Date(0) } });
  return result.count;
}

/** One queued job: runs it by kind; a server-side interruption puts it back in the queue shortly, to resume where it stopped. */
export async function processExportJob(deps: ExportWorkerDeps, jobId: string, options: Parameters<typeof runExport>[2] = {}): Promise<RunOutcome> {
  const peek = await prisma.recordingExportJob.findUnique({ where: { id: jobId }, select: { kind: true } }).catch(() => null);
  const common = { concurrency: exportConfig.concurrency(), checkpointEvery: exportConfig.checkpointEvery(), maxZipBytes: exportConfig.maxZipBytes(), maxRows: exportConfig.maxRows(), log: (m: string) => logger.warn(`[recording-export] ${m}`), ...options };
  running.add(jobId);
  let outcome: RunOutcome;
  try {
    outcome = peek?.kind === "EXCEL" ? await runExcelExport({ repo: deps.repo, store: deps.store, source: deps.excelSource }, jobId, common) : await runExport({ repo: deps.repo, store: deps.store, fetchFile: deps.fetchFile }, jobId, common);
  } finally {
    running.delete(jobId);
  }
  if (outcome === "retry") await deps.enqueue(jobId, { delaySeconds: RETRY_DELAY_SECONDS }).catch((error) => logger.warn(`[recording-export] re-queue failed job=${jobId}: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`));
  return outcome;
}

export function defaultWorkerDeps(fetchFile: RecordingFetcher = fetchRecordingFile): ExportWorkerDeps {
  return {
    repo: new PrismaExportRepo(),
    store: new PostgresBlobStore(),
    fetchFile,
    excelSource: (job) => new PrismaExcelSource(prisma, { id: job.createdById ?? "", role: (job.role ?? "ADMIN") as AuthUser["role"], username: "export" }, { from: job.fromDay, to: job.toDay }, sanitizeExportFilters(job.filters)),
    enqueue: enqueueExport,
  };
}

export async function startRecordingExportWorker(fetchFile: RecordingFetcher = fetchRecordingFile): Promise<void> {
  await ensureQueue();
  const boss = await getQueue();
  const deps = defaultWorkerDeps(fetchFile);
  await boss.work<{ jobId: string }>(exportQueueName(), { batchSize: 1, localConcurrency: exportConfig.workers() }, async (jobs) => {
    for (const job of jobs) {
      try {
        const outcome = await processExportJob(deps, job.data.jobId);
        logger.info(`[recording-export] job=${job.data.jobId} ${outcome}`);
      } catch (error) {
        // Never lets an export problem escape into the queue's own retry/expiry machinery or the process: it is logged, and the job's heartbeat goes stale and maintenance re-queues it.
        logger.error(`[recording-export] job=${job.data.jobId} crashed`, error);
      }
    }
  });
  logger.info("[recording-export] worker registered");
  // Anything that was running when the previous process stopped is handed back at once instead of waiting for the next maintenance tick.
  await recordingExportMaintenance().catch((error) => logger.warn(`[recording-export] startup recovery failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`));
}

/** Deletes expired exports (job, items and stored file) and re-queues exports whose worker disappeared (a restart / crash) or that were never picked up. */
export async function recordingExportMaintenance(
  db: Db = prisma,
  enqueue: (jobId: string, options?: { delaySeconds?: number }) => Promise<void> = enqueueExport,
  now: Date = new Date(),
  onlyUserId?: string,
): Promise<{ deleted: number; requeued: number }> {
  const expired = onlyUserId ? { count: 0 } : await db.recordingExportJob.deleteMany({ where: { expiresAt: { lte: now } } }); // items and chunks go with it (ON DELETE CASCADE)
  const staleBefore = new Date(now.getTime() - DEFAULT_RUN_OPTIONS.staleMs);
  const stuckBefore = new Date(now.getTime() - QUEUED_STUCK_MS);
  const stale = await db.recordingExportJob.findMany({
    where: {
      expiresAt: { gt: now },
      ...(onlyUserId ? { createdById: onlyUserId } : {}),
      OR: [
        { status: "PROCESSING", heartbeatAt: { lt: staleBefore } },
        { status: "PROCESSING", heartbeatAt: null, createdAt: { lt: staleBefore } },
        { status: "QUEUED", heartbeatAt: { lt: stuckBefore } },
        { status: "QUEUED", heartbeatAt: null, createdAt: { lt: stuckBefore } },
      ],
    },
    select: { id: true },
    take: 20,
  });
  let requeued = 0;
  for (const job of stale) {
    try {
      // The heartbeat is reset so the same job is not handed to the queue again on the very next tick.
      await db.recordingExportJob.updateMany({ where: { id: job.id }, data: { status: "QUEUED", heartbeatAt: now } });
      await enqueue(job.id);
      requeued++;
    } catch (error) {
      logger.warn(`[recording-export] requeue failed job=${job.id}: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  return { deleted: expired.count, requeued };
}

export function startRecordingExportMaintenance(): NodeJS.Timeout {
  const tick = () => void recordingExportMaintenance().catch((error) => logger.warn(`[recording-export] maintenance failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`));
  const timer = setInterval(tick, CLEANUP_TICK_MS);
  timer.unref?.();
  return timer;
}
