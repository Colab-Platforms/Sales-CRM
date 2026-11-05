import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Response } from "express";
import { prisma } from "@/lib/prisma.js";
import { getQueue } from "@/lib/queue.js";
import { logger } from "@/utils/logger.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { canAccessRecordings } from "./abandonment.filters.js";
import {
  AbandonmentRecordingsService,
  fetchRecordingFile,
  planRecordings,
  recordingExtension,
  recordingFileName,
  recordingRangeBounds,
  unavailableReason,
  type RecordingFetcher,
  type RecordingRange,
} from "./abandonment.recordings.js";
import { DEFAULT_RUN_OPTIONS, runExport, uniqueName, type BlobStore, type BlobWriter, type ExportItem, type ExportJobRow, type ExportRepo, type ItemResult, type JobStatus } from "./recording-export.core.js";

// Background ZIP exports of call recordings.
//  - Worker:  the app's existing pg-boss queue (same Postgres, no new service). One export per instance at a time by default (RECORDING_EXPORT_WORKERS).
//  - Storage: the finished ZIP is kept in Postgres as 4 MB chunks (recording_export_chunks). There is no object store provisioned, and local disk does not survive a restart or a
//             second instance. Chunks are written and read one at a time, so neither building nor downloading ever holds the ZIP in memory.
//  - Cleanup: jobs, items and chunks are deleted once expires_at passes (RECORDING_EXPORT_RETENTION_HOURS, default 24).

const QUEUE_NAME = "recording-export";
const CHUNK_BYTES = 4 * 1024 * 1024;
const ACTIVE: JobStatus[] = ["QUEUED", "PROCESSING"];
const MAX_ACTIVE_PER_USER = 2;
const MAX_ACTIVE_TOTAL = 10;
const CLEANUP_TICK_MS = 10 * 60_000;
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
  concurrency: () => Math.min(envNumber("RECORDING_EXPORT_CONCURRENCY", DEFAULT_RUN_OPTIONS.concurrency), 8),
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
    return job ? { id: job.id, fromDay: job.fromDay, toDay: job.toDay, status: job.status as JobStatus, total: job.total, duplicates: job.duplicates, createdAt: job.createdAt } : null;
  }

  async items(jobId: string): Promise<ExportItem[]> {
    const rows = await this.db.recordingExportItem.findMany({ where: { jobId }, orderBy: { seq: "asc" } });
    const n = (v: bigint | null) => (v === null ? null : Number(v));
    return rows.map((r) => ({ seq: r.seq, callId: r.callId, fileName: r.fileName, status: r.status as ExportItem["status"], reason: r.reason, crc32: n(r.crc32), size: n(r.size), localOffset: n(r.localOffset), endOffset: n(r.endOffset) }));
  }

  async checkpoint(jobId: string, results: ItemResult[], dataEnd: number): Promise<boolean> {
    if (results.length > 0) {
      await this.db.$transaction(
        results.map((r) =>
          this.db.recordingExportItem.updateMany({
            where: { jobId, seq: r.seq },
            data: { status: r.status, reason: r.reason ?? null, crc32: r.crc32 ?? null, size: r.size ?? null, localOffset: r.localOffset ?? null, endOffset: r.endOffset ?? null },
          }),
        ),
      );
    }
    const counts = await this.db.recordingExportItem.groupBy({ by: ["status"], where: { jobId }, _count: { _all: true } });
    const of = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
    const updated = await this.db.recordingExportJob.updateMany({ where: { id: jobId }, data: { processed: of("DONE"), failed: of("FAILED"), dataEnd, heartbeatAt: new Date() } });
    return updated.count === 1;
  }

  async heartbeat(jobId: string): Promise<void> {
    await this.db.recordingExportJob.updateMany({ where: { id: jobId, status: "PROCESSING" }, data: { heartbeatAt: new Date() } });
  }

  async source(callId: string) {
    const recording = await this.db.callRecording.findUnique({ where: { callId }, select: { recordingUrl: true, expiresAt: true } });
    return recording ? { recordingUrl: recording.recordingUrl, expiresAt: recording.expiresAt } : null;
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
  /** FAILED, or finished with some failed recordings: a retry downloads only the ones still missing. */
  canRetry: boolean;
  reused?: boolean;
}

type JobRecord = NonNullable<Awaited<ReturnType<Db["recordingExportJob"]["findUnique"]>>>;

export function toStatusDto(job: JobRecord, now: Date = new Date()): ExportStatusDto {
  const done = job.processed + job.failed;
  const expired = job.expiresAt.getTime() <= now.getTime();
  const status = job.status as JobStatus;
  return {
    id: job.id,
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
    private readonly enqueue: (jobId: string) => Promise<void> = enqueueExport,
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

  /** Starts a background export, or returns the one already running for the same user and date range. */
  async create(user: AuthUser, range: RecordingRange): Promise<ExportStatusDto> {
    this.assertAllowed(user);
    recordingRangeBounds(range); // validates the dates
    const now = new Date();
    const active = await this.db.recordingExportJob.findMany({ where: { status: { in: ACTIVE }, expiresAt: { gt: now } }, select: { id: true, createdById: true, fromDay: true, toDay: true } });
    const same = active.find((j) => j.createdById === user.id && j.fromDay === range.from && j.toDay === range.to);
    if (same) return { ...toStatusDto((await this.db.recordingExportJob.findUniqueOrThrow({ where: { id: same.id } })), now), reused: true };
    if (active.filter((j) => j.createdById === user.id).length >= MAX_ACTIVE_PER_USER) throw new ApiError("You already have exports running. Wait for one to finish before starting another.", 429);
    if (active.length >= MAX_ACTIVE_TOTAL) throw new ApiError("The server is busy with other exports. Please try again in a few minutes.", 429);

    const rows = await this.recordings.rowsFor(user, this.recordings.rangeWhere(range));
    const plan = planRecordings(rows, now);
    const count = plan.usable.length + plan.unavailable.length;
    if (count === 0) throw new ApiError("No recordings found for this date range", STATUS_CODES.NOT_FOUND);
    if (count > exportConfig.maxItems()) throw new ApiError(`${count} recordings match, more than one export can hold (${exportConfig.maxItems()}). Choose a shorter date range.`, STATUS_CODES.BAD_REQUEST);

    const taken = new Set<string>(["_summary.txt"]);
    const items = [
      ...plan.usable.map((r) => ({ r, reason: null as string | null })),
      ...plan.unavailable.map((r) => ({ r, reason: unavailableReason(r, now) ?? "unavailable" })),
    ].map(({ r, reason }, seq) => ({
      seq,
      callId: r.callId,
      fileName: uniqueName(recordingFileName({ leadNumber: r.leadNumber, customerName: r.customerName, at: r.at, callId: r.callId, extension: recordingExtension(r.recordingUrl ?? "") }), taken),
      status: reason ? "FAILED" : "PENDING",
      reason,
    }));

    const job = await this.db.recordingExportJob.create({
      data: {
        createdById: user.id,
        role: user.role,
        fromDay: range.from,
        toDay: range.to,
        total: items.length,
        failed: plan.unavailable.length,
        duplicates: plan.duplicates,
        expiresAt: new Date(now.getTime() + exportConfig.retentionHours() * 3_600_000),
      },
    });
    for (let i = 0; i < items.length; i += 1000) {
      await this.db.recordingExportItem.createMany({ data: items.slice(i, i + 1000).map((item) => ({ ...item, jobId: job.id })) });
    }
    await this.start(job.id);
    return toStatusDto((await this.db.recordingExportJob.findUniqueOrThrow({ where: { id: job.id } })), now);
  }

  private async start(jobId: string): Promise<void> {
    try {
      await this.enqueue(jobId);
    } catch (error) {
      logger.error(`[recording-export] could not queue job=${jobId}`, error);
      await this.db.recordingExportJob.updateMany({ where: { id: jobId }, data: { status: "FAILED", finishedAt: new Date(), errorMessage: "The export could not be queued. Please retry." } });
    }
  }

  async list(user: AuthUser): Promise<ExportStatusDto[]> {
    this.assertAllowed(user);
    const jobs = await this.db.recordingExportJob.findMany({ where: { createdById: user.id, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, take: 10 });
    return jobs.map((j) => toStatusDto(j));
  }

  async get(user: AuthUser, id: string): Promise<ExportStatusDto> {
    return toStatusDto(await this.ownJob(user, id));
  }

  /** Re-runs a failed export (or one that finished with failed recordings). Recordings already in the ZIP are NOT downloaded again. */
  async retry(user: AuthUser, id: string): Promise<ExportStatusDto> {
    const job = await this.ownJob(user, id);
    const dto = toStatusDto(job);
    if (ACTIVE.includes(job.status as JobStatus)) return dto;
    if (!dto.canRetry) throw new ApiError("Nothing to retry for this export", STATUS_CODES.BAD_REQUEST);
    await this.db.recordingExportItem.updateMany({ where: { jobId: id, status: "FAILED" }, data: { status: "PENDING", reason: null } });
    await this.db.recordingExportJob.updateMany({ where: { id }, data: { status: "QUEUED", errorMessage: null, finishedAt: null, heartbeatAt: null } });
    await this.start(id);
    return toStatusDto(await this.db.recordingExportJob.findUniqueOrThrow({ where: { id } }));
  }

  /** A short-lived link the browser can follow directly, so a large ZIP streams to disk instead of being buffered by the page. Issued only to the export's owner. */
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
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${job.fileName ?? `recordings_${job.fromDay}_to_${job.toDay}.zip`}"`);
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
      await boss.createQueue(QUEUE_NAME, { retryLimit: 2, retryBackoff: true });
    });
  }
  return queueReady;
}

export async function enqueueExport(jobId: string): Promise<void> {
  await ensureQueue();
  const boss = await getQueue();
  // A long job: the default 15-minute expiry would hand a still-running export to a second worker (the claim in the repo would refuse it, but there is no point).
  await boss.send(QUEUE_NAME, { jobId }, { expireInSeconds: 6 * 3600 });
}

export async function startRecordingExportWorker(fetchFile: RecordingFetcher = fetchRecordingFile): Promise<void> {
  await ensureQueue();
  const boss = await getQueue();
  const deps = { repo: new PrismaExportRepo(), store: new PostgresBlobStore(), fetchFile };
  await boss.work<{ jobId: string }>(QUEUE_NAME, { batchSize: 1, localConcurrency: exportConfig.workers() }, async (jobs) => {
    for (const job of jobs) {
      const outcome = await runExport(deps, job.data.jobId, { concurrency: exportConfig.concurrency(), maxZipBytes: exportConfig.maxZipBytes(), log: (m) => logger.warn(`[recording-export] ${m}`) });
      logger.info(`[recording-export] job=${job.data.jobId} ${outcome}`);
    }
  });
  logger.info("[recording-export] worker registered");
}

/** Deletes expired exports (job, items and stored ZIP) and re-queues exports whose worker disappeared (a restart / crash). */
export async function recordingExportMaintenance(db: Db = prisma, enqueue: (jobId: string) => Promise<void> = enqueueExport, now: Date = new Date()): Promise<{ deleted: number; requeued: number }> {
  const expired = await db.recordingExportJob.deleteMany({ where: { expiresAt: { lte: now } } }); // items and chunks go with it (ON DELETE CASCADE)
  const stale = await db.recordingExportJob.findMany({
    where: { expiresAt: { gt: now }, OR: [{ status: "PROCESSING", heartbeatAt: { lt: new Date(now.getTime() - DEFAULT_RUN_OPTIONS.staleMs) } }, { status: "QUEUED", createdAt: { lt: new Date(now.getTime() - 15 * 60_000) } }] },
    select: { id: true },
    take: 20,
  });
  let requeued = 0;
  for (const job of stale) {
    try {
      await db.recordingExportJob.updateMany({ where: { id: job.id, status: "PROCESSING" }, data: { status: "QUEUED" } });
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
  tick();
  const timer = setInterval(tick, CLEANUP_TICK_MS);
  timer.unref?.();
  return timer;
}
