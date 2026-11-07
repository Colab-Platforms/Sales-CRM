import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import JSZip from "jszip";
import { Role } from "../../../generated/prisma/enums.js";
import { PermanentRecordingError, allowedRecordingHosts, assertFetchableRecordingUrl, isAllowedRecordingHost, planRecordings, withRetries, type RecordingRow } from "./abandonment.recordings.js";
import { runExport, uniqueName, type BlobStore, type BlobWriter, type ExportItem, type ExportJobRow, type ExportRepo, type ItemResult } from "./recording-export.core.js";
import { PostgresBlobStore, RecordingExportService, recordingExportMaintenance, toStatusDto } from "./recording-export.service.js";

// ---------- in-memory fakes: the same engine that runs in production, with no database, no network and no real recordings ----------

class MemoryRepo implements ExportRepo {
  status: ExportJobRow["status"] = "QUEUED";
  heartbeatAt: Date | null = null;
  finished: { status: string; sizeBytes?: number; errorMessage?: string | null; fileName?: string } | null = null;
  checkpoints = 0;
  attempts = 0;
  releaseMessage: string | null = null;
  deleted = false;
  readonly rows: ExportItem[];
  constructor(count: number, readonly failIds: Set<number> = new Set(), readonly job: ExportJobRow = { id: "job-1", fromDay: "2026-11-01", toDay: "2026-11-05", status: "QUEUED", total: count, duplicates: 0, createdAt: new Date("2026-11-05T10:00:00Z") }) {
    this.rows = Array.from({ length: count }, (_, seq) => ({ seq, callId: `call-${seq}`, fileName: `LEAD-${seq}_Customer_${seq}_2026-11-05_1000_${String(seq).padStart(8, "0")}.mp3`, status: "PENDING", reason: null, crc32: null, size: null, localOffset: null, endOffset: null }));
  }
  async claim(_id: string, staleMs: number) {
    const stale = this.status === "PROCESSING" && this.heartbeatAt && Date.now() - this.heartbeatAt.getTime() > staleMs;
    if (this.deleted || !(this.status === "QUEUED" || stale)) return null;
    this.status = "PROCESSING";
    this.heartbeatAt = new Date();
    this.attempts++;
    return { ...this.job, status: "PROCESSING" as const };
  }
  async progress() {
    return !this.deleted;
  }
  async release(_id: string, message: string, maxAttempts: number) {
    if (this.attempts >= maxAttempts) {
      this.status = "FAILED";
      this.finished = { status: "FAILED", errorMessage: message };
      return "failed" as const;
    }
    this.status = "QUEUED";
    this.releaseMessage = message;
    return "requeued" as const;
  }
  async items() {
    return this.rows.map((r) => ({ ...r }));
  }
  async checkpoint(_id: string, results: ItemResult[], _end?: number) {
    if (this.deleted) return false;
    this.checkpoints++;
    for (const r of results) Object.assign(this.rows[r.seq]!, { status: r.status, reason: r.reason ?? null, crc32: r.crc32 ?? null, size: r.size ?? null, localOffset: r.localOffset ?? null, endOffset: r.endOffset ?? null });
    return true;
  }
  async heartbeat() {
    this.heartbeatAt = new Date();
  }
  sourceCalls = 0;
  async sources(callIds: string[]) {
    this.sourceCalls++;
    return new Map(callIds.map((id) => [id, { recordingUrl: `https://rec.callerdesk.io/${id}.mp3`, expiresAt: null }]));
  }
  async finish(_id: string, patch: { status: "COMPLETED" | "FAILED"; sizeBytes?: number; errorMessage?: string | null; fileName?: string }) {
    this.status = patch.status;
    this.finished = patch;
  }
  /** What the service's retry does: failed recordings go back to pending, the job back to queued. */
  retry() {
    for (const r of this.rows) if (r.status === "FAILED") Object.assign(r, { status: "PENDING", reason: null });
    this.status = "QUEUED";
    this.finished = null;
  }
}

class MemoryStore implements BlobStore {
  data = Buffer.alloc(0);
  failWriteAfter = Infinity;
  writes = 0;
  async openWriter(_id: string, offset: number): Promise<BlobWriter> {
    const self = this;
    self.data = self.data.subarray(0, offset);
    let parts: Buffer[] = [];
    let length = self.data.length;
    return {
      get offset() {
        return length;
      },
      async write(chunk: Buffer) {
        if (++self.writes > self.failWriteAfter) throw new Error("storage unavailable");
        parts.push(chunk);
        length += chunk.length;
      },
      async flush() {
        self.data = Buffer.concat([self.data, ...parts]);
        parts = [];
      },
    };
  }
}

const audio = (callId: string) => Buffer.from(`RIFF-${callId}-`.repeat(12));

function makeFetcher(failing: Set<string> = new Set(), onFetch?: (url: string) => void) {
  let inFlight = 0;
  const state = { calls: 0, maxInFlight: 0, fetched: [] as string[] };
  const fetchFile = async (url: string) => {
    state.calls++;
    state.fetched.push(url);
    inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
    onFetch?.(url);
    const id = /\/(call-\d+)\.mp3$/.exec(url)![1]!;
    if (failing.has(id)) throw new PermanentRecordingError("provider answered 404");
    return { data: audio(id), contentType: "audio/mpeg" };
  };
  return { fetchFile, state };
}

async function verifyZip(buf: Buffer, rows: ExportItem[]) {
  const zip = await JSZip.loadAsync(buf, { checkCRC32: true });
  const done = rows.filter((r) => r.status === "DONE");
  const names = Object.keys(zip.files).filter((n) => n !== "_summary.txt");
  assert.equal(names.length, done.length, "one entry per successful recording");
  assert.equal(new Set(names).size, names.length, "no duplicate file names");
  for (const r of [done[0], done[Math.floor(done.length / 2)], done[done.length - 1]]) {
    if (!r) continue;
    assert.equal((await zip.file(r.fileName)!.async("nodebuffer")).toString(), audio(r.callId).toString());
  }
  return zip;
}

// ---------- large exports ----------

for (const count of [300, 1000, 2000, 5000]) {
  test(`${count} recordings: all included, valid ZIP, bounded concurrency, summary counts, some failures skipped`, async () => {
    const failing = new Set(Array.from({ length: Math.floor(count / 50) }, (_, i) => `call-${i * 50 + 7}`)); // 2% unavailable
    const repo = new MemoryRepo(count);
    const store = new MemoryStore();
    const { fetchFile, state } = makeFetcher(failing);
    const outcome = await runExport({ repo, store, fetchFile }, "job-1", { concurrency: 4, checkpointEvery: 25 });
    assert.equal(outcome, "completed");
    assert.equal(state.calls, count, "each recording is downloaded exactly once");
    assert.ok(repo.sourceCalls <= Math.ceil(count / 200), `recording links are looked up in batches, not one query per recording (${repo.sourceCalls} queries for ${count})`);
    assert.ok(state.maxInFlight <= 4, `never more than the configured concurrency in flight (saw ${state.maxInFlight})`);
    const done = repo.rows.filter((r) => r.status === "DONE").length;
    assert.equal(done, count - failing.size);
    assert.equal(repo.rows.filter((r) => r.status === "FAILED").length, failing.size);
    assert.equal(repo.finished?.sizeBytes, store.data.length);
    const zip = await verifyZip(store.data, repo.rows);
    const summary = await zip.file("_summary.txt")!.async("string");
    assert.match(summary, new RegExp(`Total recordings: ${count}`));
    assert.match(summary, new RegExp(`Downloaded successfully: ${count - failing.size}`));
    assert.match(summary, new RegExp(`Failed / unavailable: ${failing.size}`));
    assert.match(summary, /provider answered 404/);
  });
}

test("duplicates and unavailable links are decided when the job is planned: one entry per distinct recording", () => {
  const at = new Date("2026-11-05T08:00:00Z");
  const rows: RecordingRow[] = Array.from({ length: 1000 }, (_, i) => ({ callId: `c${i}`, recordingUrl: i % 10 === 0 ? `https://rec.callerdesk.io/shared.mp3` : `https://rec.callerdesk.io/${i}.mp3`, expiresAt: null, at, leadNumber: "L", customerName: "C" }));
  rows.push({ callId: "x1", recordingUrl: null, expiresAt: null, at, leadNumber: "L", customerName: "C" });
  rows.push({ callId: "x2", recordingUrl: "https://evil.example.org/a.mp3", expiresAt: null, at, leadNumber: "L", customerName: "C" });
  const plan = planRecordings(rows);
  assert.equal(plan.usable.length, 900 + 1); // 900 distinct + the shared one once
  assert.equal(plan.duplicates, 99);
  assert.equal(plan.unavailable.length, 2);
  const taken = new Set<string>();
  assert.deepEqual([uniqueName("a_1.mp3", taken), uniqueName("a_1.mp3", taken), uniqueName("a_1.mp3", taken)], ["a_1.mp3", "a_1_2.mp3", "a_1_3.mp3"]);
});

// ---------- resume, retry, failure ----------

test("a crash mid-export resumes from the last checkpoint and never downloads a finished recording again", async () => {
  const count = 600;
  const repo = new MemoryRepo(count);
  const store = new MemoryStore();
  const first = makeFetcher();
  store.failWriteAfter = 400; // the storage dies part-way through
  // A storage problem is the server's, not the job's: the job goes back to the queue with its progress, it is NOT marked failed.
  assert.equal(await runExport({ repo, store, fetchFile: first.fetchFile }, "job-1", { concurrency: 3, checkpointEvery: 20, sleep: async () => undefined }), "retry");
  assert.equal(repo.status, "QUEUED");
  assert.match(repo.releaseMessage ?? "", /storage unavailable/);
  const savedBefore = repo.rows.filter((r) => r.status === "DONE").length;
  assert.ok(savedBefore > 0 && savedBefore < count);

  store.failWriteAfter = Infinity;
  const second = makeFetcher();
  assert.equal(await runExport({ repo, store, fetchFile: second.fetchFile }, "job-1", { concurrency: 3, checkpointEvery: 20 }), "completed");
  assert.equal(second.state.calls, count - savedBefore, "only the recordings that were not yet in the ZIP are downloaded");
  const refetched = new Set(second.state.fetched.map((u) => /(call-\d+)/.exec(u)![1]));
  for (const r of repo.rows.slice(0, savedBefore)) assert.equal(refetched.has(r.callId), false);
  await verifyZip(store.data, repo.rows);
});

test("retrying a finished export with failed recordings downloads only those and rebuilds the ZIP end", async () => {
  const repo = new MemoryRepo(300);
  const store = new MemoryStore();
  const flaky = new Set(["call-3", "call-150", "call-299"]);
  assert.equal(await runExport({ repo, store, fetchFile: makeFetcher(flaky).fetchFile }, "job-1"), "completed");
  assert.equal(repo.rows.filter((r) => r.status === "FAILED").length, 3);

  repo.retry();
  const again = makeFetcher(); // the provider has recovered
  assert.equal(await runExport({ repo, store, fetchFile: again.fetchFile }, "job-1"), "completed");
  assert.deepEqual(again.state.fetched.sort(), ["call-150", "call-299", "call-3"].map((c) => `https://rec.callerdesk.io/${c}.mp3`).sort());
  const zip = await verifyZip(store.data, repo.rows);
  assert.equal(repo.rows.filter((r) => r.status === "DONE").length, 300);
  assert.match(await zip.file("_summary.txt")!.async("string"), /Failed \/ unavailable: 0/);
});

test("when every recording fails the job fails with a clear, retryable message", async () => {
  const repo = new MemoryRepo(40);
  const all = new Set(repo.rows.map((r) => r.callId));
  assert.equal(await runExport({ repo, store: new MemoryStore(), fetchFile: makeFetcher(all).fetchFile }, "job-1"), "failed");
  assert.match(repo.finished?.errorMessage ?? "", /None of the 40 recordings could be downloaded/);
});

test("a ZIP over the size limit fails with a message instead of exhausting storage", async () => {
  const repo = new MemoryRepo(200);
  assert.equal(await runExport({ repo, store: new MemoryStore(), fetchFile: makeFetcher().fetchFile }, "job-1", { maxZipBytes: 10_000 }), "failed");
  assert.match(repo.finished?.errorMessage ?? "", /larger than the .* MB limit/);
});

test("two workers cannot run the same job; a job deleted mid-run stops quietly", async () => {
  const repo = new MemoryRepo(100);
  const [a, b] = await Promise.all([runExport({ repo, store: new MemoryStore(), fetchFile: makeFetcher().fetchFile }, "job-1"), runExport({ repo, store: new MemoryStore(), fetchFile: makeFetcher().fetchFile }, "job-1")]);
  assert.deepEqual([a, b].sort(), ["completed", "skipped"]);

  const gone = new MemoryRepo(100);
  const fetcher = makeFetcher(new Set(), () => {
    if (fetcher.state.calls === 30) gone.deleted = true;
  });
  assert.equal(await runExport({ repo: gone, store: new MemoryStore(), fetchFile: fetcher.fetchFile }, "job-1", { checkpointEvery: 10 }), "skipped");
});

test("a stale PROCESSING job (worker vanished) can be taken over", async () => {
  const repo = new MemoryRepo(10);
  repo.status = "PROCESSING";
  repo.heartbeatAt = new Date(Date.now() - 10 * 60_000);
  assert.equal(await runExport({ repo, store: new MemoryStore(), fetchFile: makeFetcher().fetchFile }, "job-1"), "completed");
  const fresh = new MemoryRepo(10);
  fresh.status = "PROCESSING";
  fresh.heartbeatAt = new Date();
  assert.equal(await runExport({ repo: fresh, store: new MemoryStore(), fetchFile: makeFetcher().fetchFile }, "job-1"), "skipped");
});

// ---------- the Postgres chunk store (against a fake table) ----------

function fakeChunkDb() {
  const table = new Map<string, Buffer>();
  const key = (jobId: string, seq: number) => `${jobId}:${seq}`;
  const db = {
    recordingExportChunk: {
      deleteMany: async ({ where }: { where: { jobId: string; seq: number | { gt: number } } }) => {
        for (const k of [...table.keys()]) {
          const [j, s] = k.split(":");
          if (j !== where.jobId) continue;
          const seq = Number(s);
          if (typeof where.seq === "number" ? seq === where.seq : seq > where.seq.gt) table.delete(k);
        }
      },
      findUnique: async ({ where }: { where: { jobId_seq: { jobId: string; seq: number } } }) => {
        const v = table.get(key(where.jobId_seq.jobId, where.jobId_seq.seq));
        return v ? { data: new Uint8Array(v) } : null;
      },
      upsert: async ({ where, create }: { where: { jobId_seq: { jobId: string; seq: number } }; create: { data: Uint8Array } }) => {
        table.set(key(where.jobId_seq.jobId, where.jobId_seq.seq), Buffer.from(create.data));
      },
    },
  };
  return { db: db as never, table };
}

test("Postgres chunk store: chunk boundaries, resume/truncate, and streaming back byte-for-byte", async () => {
  const { db, table } = fakeChunkDb();
  const store = new PostgresBlobStore(db, 64); // tiny chunks so every boundary is exercised
  const w = await store.openWriter("j", 0);
  const payload = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  for (let i = 0; i < payload.length; i += 37) await w.write(payload.subarray(i, i + 37));
  await w.flush();
  assert.equal(w.offset, 1000);
  const read = async (size: number) => {
    const out: Buffer[] = [];
    for await (const c of store.stream("j", size)) out.push(c);
    return Buffer.concat(out);
  };
  assert.deepEqual(await read(1000), payload);

  // resume at 300 (mid-chunk) and at 320 (exactly on a boundary): everything after is discarded and rewritten
  for (const at of [300, 320]) {
    const full = await store.openWriter("j", 0);
    await full.write(payload);
    await full.flush();
    const r = await store.openWriter("j", at);
    assert.equal(r.offset, at);
    await r.write(Buffer.from("TAIL"));
    await r.flush();
    const expected = Buffer.concat([payload.subarray(0, at), Buffer.from("TAIL")]);
    assert.deepEqual(await read(expected.length), expected);
    assert.ok([...table.keys()].every((k) => Number(k.split(":")[1]) <= Math.floor(expected.length / 64)), "no stale chunks beyond the new end");
  }
  await assert.rejects(() => store.openWriter("j", 99_999), /incomplete/);
});

test("the engine produces a valid ZIP through the Postgres chunk store, and a resumed one too", async () => {
  const { db } = fakeChunkDb();
  const store = new PostgresBlobStore(db, 1024);
  const repo = new MemoryRepo(250);
  assert.equal(await runExport({ repo, store, fetchFile: makeFetcher(new Set(["call-10"])).fetchFile }, "job-1", { checkpointEvery: 10 }), "completed");
  const out: Buffer[] = [];
  for await (const c of store.stream("job-1", repo.finished!.sizeBytes!)) out.push(c);
  await verifyZip(Buffer.concat(out), repo.rows);

  repo.retry();
  assert.equal(await runExport({ repo, store, fetchFile: makeFetcher().fetchFile }, "job-1"), "completed");
  const out2: Buffer[] = [];
  for await (const c of store.stream("job-1", repo.finished!.sizeBytes!)) out2.push(c);
  await verifyZip(Buffer.concat(out2), repo.rows);
});

// ---------- permissions, ownership, status ----------

const noDb = new Proxy({}, { get: () => assert.fail("database must not be reached") }) as never;
const noQueue = async () => assert.fail("must not enqueue");

test("only admin and manager can create, list, read, retry or download an export", async () => {
  const service = new RecordingExportService(noDb, undefined, noQueue);
  for (const role of [Role.SALESPERSON, Role.HR, Role.RECRUITER]) {
    const user = { id: "u", role, username: "x" };
    await assert.rejects(() => service.create(user, { from: "2026-11-05", to: "2026-11-05" }), { statusCode: 403 });
    await assert.rejects(() => service.list(user), { statusCode: 403 });
    await assert.rejects(() => service.get(user, "11111111-2222-3333-4444-555555555555"), { statusCode: 403 });
    await assert.rejects(() => service.retry(user, "11111111-2222-3333-4444-555555555555"), { statusCode: 403 });
    await assert.rejects(() => service.download(user, "11111111-2222-3333-4444-555555555555", {} as never), { statusCode: 403 });
  }
});

test("an export is invisible to everyone but its creator, and an expired one is gone", async () => {
  const job = { id: "11111111-2222-3333-4444-555555555555", createdById: "owner", expiresAt: new Date(Date.now() + 3_600_000), status: "COMPLETED", total: 1, processed: 1, failed: 0, duplicates: 0, sizeBytes: 10n, fromDay: "a", toDay: "b", fileName: "f.zip", errorMessage: null, createdAt: new Date(), finishedAt: new Date() };
  const db = { recordingExportJob: { findUnique: async () => job } } as never;
  const service = new RecordingExportService(db, undefined, noQueue);
  await assert.rejects(() => service.get({ id: "other-manager", role: Role.MANAGER, username: "m" }, job.id), { statusCode: 404 });
  await assert.rejects(() => service.download({ id: "other-manager", role: Role.ADMIN, username: "a" }, job.id, {} as never), { statusCode: 404 });
  assert.equal((await service.get({ id: "owner", role: Role.MANAGER, username: "m" }, job.id)).canDownload, true);
  job.expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(() => service.get({ id: "owner", role: Role.MANAGER, username: "m" }, job.id), { statusCode: 404 });
});

test("an identical active export is reused instead of starting a second one", async () => {
  const job = { id: "j1", kind: "ZIP", filters: null, heartbeatAt: new Date(), attempts: 0, createdById: "owner", fromDay: "2026-11-05", toDay: "2026-11-05", status: "PROCESSING", total: 500, processed: 120, failed: 5, duplicates: 0, sizeBytes: 0n, fileName: null, errorMessage: null, createdAt: new Date(), finishedAt: null, expiresAt: new Date(Date.now() + 3_600_000) };
  const db = { recordingExportJob: { findMany: async () => [job], findUniqueOrThrow: async () => job } } as never;
  const service = new RecordingExportService(db, undefined, noQueue);
  const dto = await service.create({ id: "owner", role: Role.MANAGER, username: "m" }, { from: "2026-11-05", to: "2026-11-05" });
  assert.equal(dto.reused, true);
  assert.equal(dto.id, "j1");
  assert.equal(dto.remaining, 375);
  assert.equal(dto.percent, 25);
});

test("status reports totals, remaining, percentage and retry/download availability", () => {
  const base = { id: "x", fromDay: "a", toDay: "b", total: 200, processed: 150, failed: 10, duplicates: 3, sizeBytes: 0n, fileName: null, errorMessage: null, createdAt: new Date(), finishedAt: null, expiresAt: new Date(Date.now() + 1e6) };
  assert.deepEqual([toStatusDto({ ...base, status: "PROCESSING" } as never)].map((d) => [d.remaining, d.percent, d.canDownload, d.canRetry]), [[40, 80, false, false]]);
  const done = toStatusDto({ ...base, status: "COMPLETED", processed: 190 } as never);
  assert.deepEqual([done.percent, done.canDownload, done.canRetry], [100, true, true]);
  assert.equal(toStatusDto({ ...base, status: "FAILED" } as never).canRetry, true);
  assert.equal(toStatusDto({ ...base, status: "COMPLETED", failed: 0, processed: 200 } as never).canRetry, false);
  assert.equal(toStatusDto({ ...base, status: "COMPLETED", expiresAt: new Date(0) } as never).canDownload, false);
});

// ---------- cleanup ----------

test("maintenance deletes expired exports and re-queues ones whose worker disappeared", async () => {
  const calls: string[] = [];
  const queued: string[] = [];
  const db = {
    recordingExportJob: {
      deleteMany: async ({ where }: { where: { expiresAt: { lte: Date } } }) => {
        calls.push(`delete<=${where.expiresAt.lte.toISOString()}`);
        return { count: 3 };
      },
      findMany: async () => [{ id: "stuck-1" }, { id: "stuck-2" }],
      updateMany: async () => ({ count: 1 }),
    },
  } as never;
  const now = new Date("2026-11-06T12:00:00Z");
  const result = await recordingExportMaintenance(db, async (id) => void queued.push(id), now);
  assert.deepEqual(result, { deleted: 3, requeued: 2 });
  assert.deepEqual(calls, ["delete<=2026-11-06T12:00:00.000Z"]);
  assert.deepEqual(queued, ["stuck-1", "stuck-2"]);
});

// ---------- fetching: retries and approved hosts ----------

test("transient failures are retried with backoff; permanent ones are not", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const flaky = withRetries(async () => {
    if (++attempts < 3) throw new Error("provider answered 503");
    return { data: Buffer.from("ok"), contentType: null };
  }, { sleep: async (ms) => void sleeps.push(ms) });
  assert.equal((await flaky("u")).data.toString(), "ok");
  assert.deepEqual([attempts, sleeps], [3, [500, 1500]]);

  let permanentAttempts = 0;
  const permanent = withRetries(async () => {
    permanentAttempts++;
    throw new PermanentRecordingError("provider answered 404");
  }, { sleep: async () => undefined });
  await assert.rejects(() => permanent("u"), /404/);
  assert.equal(permanentAttempts, 1);

  let exhausted = 0;
  await assert.rejects(() => withRetries(async () => { exhausted++; throw new Error("timeout"); }, { sleep: async () => undefined })("u"), /timeout/);
  assert.equal(exhausted, 3);
});

test("only https recording URLs on approved hosts are fetched", () => {
  assert.doesNotThrow(() => assertFetchableRecordingUrl("https://rec.callerdesk.io/a.mp3", ["callerdesk.io"]));
  for (const bad of ["https://evil.example.org/a.mp3", "https://callerdesk.io.evil.org/a", "http://rec.callerdesk.io/a", "https://127.0.0.1/a", "https://169.254.169.254/x"]) {
    assert.throws(() => assertFetchableRecordingUrl(bad, ["callerdesk.io"]), bad);
  }
  assert.equal(isAllowedRecordingHost("a.b.example.com", ["*.example.com"]), true);
  assert.equal(isAllowedRecordingHost("example.com", ["*.example.com"]), false);
  assert.ok(allowedRecordingHosts({ RECORDING_ALLOWED_HOSTS: "recordings.example.net, *.cdn.example.org" }).includes("recordings.example.net"));
  assert.equal(allowedRecordingHosts({ RECORDING_ALLOWED_HOSTS: "*" }).includes("*"), false, "a wildcard-everything entry is ignored");
});

// ---------- signed download link ----------

test("the download link is bound to one export and one user, expires, and cannot be forged", async () => {
  process.env.JWT_SECRET ??= "test-secret";
  const id = "11111111-2222-3333-4444-555555555555";
  const job = { id, createdById: "owner", expiresAt: new Date(Date.now() + 3_600_000), status: "COMPLETED", total: 1, processed: 1, failed: 0, duplicates: 0, sizeBytes: 10n, fromDay: "a", toDay: "b", fileName: "f.zip", errorMessage: null, createdAt: new Date(), finishedAt: new Date() };
  const db = { recordingExportJob: { findUnique: async () => job }, user: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === "owner" ? { id: "owner", role: Role.MANAGER, username: "m" } : null) } } as never;
  const service = new RecordingExportService(db, undefined, noQueue);
  const { url } = await service.downloadLink({ id: "owner", role: Role.MANAGER, username: "m" }, id);
  const q = new URL(url, "https://x.test").searchParams;
  const [u, e, s] = [q.get("u")!, Number(q.get("e")), q.get("s")!];
  const res = {} as never;
  // forged signature, wrong user, tampered expiry: refused before anything is read or sent
  await assert.rejects(() => service.downloadByLink(id, u, e, s.slice(0, -2) + "xx", res), { statusCode: 403 });
  await assert.rejects(() => service.downloadByLink(id, "someone-else", e, s, res), { statusCode: 403 });
  await assert.rejects(() => service.downloadByLink(id, u, e + 3600, s, res), { statusCode: 403 });
  await assert.rejects(() => service.downloadByLink("99999999-2222-3333-4444-555555555555", u, e, s, res), { statusCode: 403 });
  // a telecaller / HR can never be issued a link
  await assert.rejects(() => service.downloadLink({ id: "owner", role: Role.SALESPERSON, username: "t" }, id), { statusCode: 403 });
});

// ---------- transient problems never fail a good job ----------

test("a database blip during a checkpoint is retried in place; the export still completes with no extra downloads", async () => {
  const repo = new MemoryRepo(120);
  const realCheckpoint = repo.checkpoint.bind(repo);
  let blips = 2;
  repo.checkpoint = async (id: string, results: ItemResult[], end: number) => {
    if (blips-- > 0) throw new Error("connection reset by peer");
    return realCheckpoint(id, results, end);
  };
  const { fetchFile, state } = makeFetcher();
  assert.equal(await runExport({ repo, store: new MemoryStore(), fetchFile }, "job-1", { checkpointEvery: 20, sleep: async () => undefined }), "completed");
  assert.equal(state.calls, 120);
  assert.equal(repo.status, "COMPLETED");
});

test("a database outage that outlasts the retries re-queues the job (progress kept); only after maxAttempts does it fail, with the reason", async () => {
  const repo = new MemoryRepo(60);
  const realCheckpoint = repo.checkpoint.bind(repo);
  let down = true;
  repo.checkpoint = async (id: string, results: ItemResult[], end: number) => {
    if (down) throw new Error("database unavailable");
    return realCheckpoint(id, results, end);
  };
  const store = new MemoryStore();
  const opts = { checkpointEvery: 10, sleep: async () => undefined, maxAttempts: 3 };
  assert.equal(await runExport({ repo, store, fetchFile: makeFetcher().fetchFile }, "job-1", opts), "retry");
  assert.equal(repo.status, "QUEUED");
  assert.equal(await runExport({ repo, store, fetchFile: makeFetcher().fetchFile }, "job-1", opts), "retry");
  assert.equal(await runExport({ repo, store, fetchFile: makeFetcher().fetchFile }, "job-1", opts), "failed");
  assert.equal(repo.status, "FAILED");
  assert.match(repo.finished?.errorMessage ?? "", /database unavailable/);
  // the database comes back, the user retries: a fresh attempt budget, the job completes
  down = false;
  repo.attempts = 0;
  repo.status = "QUEUED";
  assert.equal(await runExport({ repo, store, fetchFile: makeFetcher().fetchFile }, "job-1", opts), "completed");
  await verifyZip(store.data, repo.rows);
});

test("the sliding window keeps downloads flowing: a slow recording does not stall the others, and output order is unchanged", async () => {
  const repo = new MemoryRepo(40);
  const order: string[] = [];
  let inFlight = 0;
  let max = 0;
  const fetchFile = async (url: string) => {
    inFlight++;
    max = Math.max(max, inFlight);
    const id = /(call-\d+)/.exec(url)![1]!;
    await new Promise((r) => setTimeout(r, id === "call-0" ? 60 : 2)); // the first one is slow
    inFlight--;
    order.push(id);
    return { data: audio(id), contentType: null };
  };
  const store = new MemoryStore();
  const outcome = await runExport({ repo, store, fetchFile }, "job-1", { concurrency: 5 });
  assert.equal(outcome, "completed", repo.finished?.errorMessage ?? repo.releaseMessage ?? "");
  assert.equal(max, 5, "the window stays full while the slow one is outstanding");
  assert.notEqual(order[0], "call-0", "later downloads finish before the slow first one");
  const zip = await verifyZip(store.data, repo.rows);
  assert.deepEqual(Object.keys(zip.files).filter((n) => n !== "_summary.txt"), repo.rows.map((r) => r.fileName), "entries are written in item order regardless of finish order");
});
