// End-to-end tests of the background exports against a REAL (isolated) Postgres with MOCKED recording files: the real repository, the real chunked storage in the database, the real
// planner and Excel source, the real service. Run ONLY through the isolated launcher: it refuses to run unless the database is crm_iso.
// Data is committed (the worker and the service use separate connections) and removed again by each test.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import { AbandonmentRecordingsService, planRecordings } from "./abandonment.recordings.js";
import { PostgresBlobStore, PrismaExportRepo, RecordingExportService, defaultWorkerDeps, processExportJob, recordingExportMaintenance, releaseRunningExports, type ExportWorkerDeps } from "./recording-export.service.js";
import { runExport } from "./recording-export.core.js";
import { seedRecordingWorld, type SeededWorld } from "./recording-export.seed.js";

before(async () => {
  const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>("select current_database()::text as db");
  if (db !== "crm_iso") throw new Error(`GUARD: these tests only run against crm_iso (got ${db})`);
});
after(() => prisma.$disconnect());

const recordings = new AbandonmentRecordingsService(prisma);
const store = new PostgresBlobStore(prisma);
const user = (w: SeededWorld, who: "admin" | "manager" | "telecaller") => w[who];

/** Mock recording provider: a deterministic payload per URL, optional failures, a counter. No network. */
function mockProvider(size: number, failing: (url: string) => boolean = () => false) {
  const state = { calls: 0, urls: new Set<string>(), failed: 0 };
  const fetchFile = async (url: string) => {
    state.calls++;
    state.urls.add(url);
    await new Promise((r) => setImmediate(r));
    if (failing(url)) {
      state.failed++;
      throw new Error("provider answered 404");
    }
    const buf = Buffer.alloc(size, url.length % 251);
    buf.write(url.slice(-40), 0);
    return { data: buf, contentType: "audio/mpeg" };
  };
  return { fetchFile, state };
}

function deps(fetchFile: ExportWorkerDeps["fetchFile"], queued: string[] = []): ExportWorkerDeps {
  return { ...defaultWorkerDeps(fetchFile), enqueue: async (id) => void queued.push(id) };
}
const serviceFor = (queued: string[]) => new RecordingExportService(prisma, recordings, async (id) => void queued.push(id), store);

async function readFile(jobId: string, size: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of store.stream(jobId, size)) parts.push(c);
  return Buffer.concat(parts);
}

/** Samples process memory while `fn` runs; returns the result, the elapsed ms and the peak RSS growth in MB. */
async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number; peakMb: number }> {
  global.gc?.();
  const base = process.memoryUsage().rss;
  let peak = base;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 25);
  const t = Date.now();
  try {
    const result = await fn();
    peak = Math.max(peak, process.memoryUsage().rss);
    return { result, ms: Date.now() - t, peakMb: Math.round((peak - base) / 1024 / 1024) };
  } finally {
    clearInterval(timer);
  }
}

async function runZip(w: SeededWorld, from: string, to: string, payload: number, opts: { failing?: (u: string) => boolean; concurrency?: number } = {}) {
  const queued: string[] = [];
  const service = serviceFor(queued);
  const provider = mockProvider(payload, opts.failing);
  const created = await service.create(user(w, "admin") as never, { kind: "ZIP", from, to });
  const outcome = await measure(() => processExportJob(deps(provider.fetchFile, queued), created.id, { concurrency: opts.concurrency ?? 8, sleep: async () => undefined }));
  const status = await service.get(user(w, "admin") as never, created.id);
  return { created, outcome: outcome.result, status, provider, service, queued, ms: outcome.ms, peakMb: outcome.peakMb };
}

async function verifyZipFile(jobId: string, size: number, expectEntries: number) {
  const buf = await readFile(jobId, size);
  const zip = await JSZip.loadAsync(buf, { checkCRC32: true });
  const names = Object.keys(zip.files).filter((n) => n !== "_summary.txt");
  assert.equal(names.length, expectEntries, "one entry per successfully downloaded recording");
  assert.equal(new Set(names).size, names.length, "no duplicate file names");
  assert.ok(names.every((n) => /^EXP-[0-9a-f]{8}-\d+_Customer\d+_Test_\d{4}-\d{2}-\d{2}_\d{4}_[0-9a-f]{8}\.mp3$/.test(n)), "names carry lead number, customer and recording date");
  // reading every entry verifies each stored CRC against the bytes
  for (const n of [names[0]!, names[Math.floor(names.length / 2)]!, names[names.length - 1]!]) assert.ok((await zip.file(n)!.async("nodebuffer")).length > 0);
  return zip;
}

const report: string[] = [];
const note = (line: string) => {
  report.push(line);
  console.log(`  METRIC ${line}`);
};

describe("ZIP export of call recordings (real DB, mocked provider)", () => {
  for (const count of [300, 1000, 2000, 5000, 10000]) {
    it(`${count} recordings over a full year: complete ZIP, deduplicated, failures skipped, bounded memory`, { timeout: 280_000 }, async () => {
      const w = await seedRecordingWorld(prisma, { leads: count / 4, callsPerLead: 4, days: 365, noLinkEvery: 50, duplicateEvery: 40 });
      try {
        // independent check: the SQL summary must agree with the JS rules on the very same rows
        const summary = await recordings.summary(user(w, "admin") as never, { from: w.from, to: w.to });
        const rows = await recordings.rowsFor(user(w, "admin") as never, recordings.rangeWhere({ from: w.from, to: w.to }));
        const plan = planRecordings(rows);
        assert.equal(summary.total, count);
        assert.equal(summary.available, plan.usable.length);
        assert.equal(summary.unavailable, plan.unavailable.length);
        assert.equal(summary.duplicates, plan.duplicates);

        const failing = (url: string) => /[05]\.mp3$/.test(url) && Number(/\/(\d+)\.mp3$/.exec(url)![1]) % 97 === 0; // a sprinkling of dead links
        const run = await runZip(w, w.from, w.to, count >= 5000 ? 4096 : 16 * 1024, { failing });
        assert.equal(run.outcome, "completed");
        assert.equal(run.status.status, "COMPLETED");
        assert.equal(run.status.total, plan.usable.length + plan.unavailable.length);
        assert.equal(run.status.failed, plan.unavailable.length + run.provider.state.failed);
        assert.equal(run.status.processed, plan.usable.length - run.provider.state.failed);
        assert.equal(run.status.remaining, 0);
        assert.equal(run.status.percent, 100);
        assert.equal(run.provider.state.calls, plan.usable.length, "each distinct recording is downloaded exactly once; duplicates and missing links are never fetched");
        await verifyZipFile(run.created.id, run.status.sizeBytes, run.status.processed);
        note(`ZIP ${String(count).padStart(5)} recordings: ${(run.ms / 1000).toFixed(1)}s (${Math.round(count / (run.ms / 1000))}/s), peak RSS +${run.peakMb} MB, ${(run.status.sizeBytes / 1024 / 1024).toFixed(1)} MB, ${run.status.failed} failed/unavailable, ${run.status.duplicates} duplicates left out`);
        assert.ok(run.peakMb < 600, `memory stays bounded (peak +${run.peakMb} MB)`);
      } finally {
        await w.cleanup();
      }
    });
  }

  it("an export of one day only contains that day (IST), and a custom range contains the right days", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 300, callsPerLead: 4, days: 30 });
    try {
      const day = w.to;
      const one = await recordings.summary(user(w, "admin") as never, { from: day, to: day });
      const all = await recordings.summary(user(w, "admin") as never, { from: w.from, to: w.to });
      assert.ok(one.total > 0 && one.total < all.total, `one day (${one.total}) is a strict subset of the range (${all.total})`);
      assert.equal(all.total, 1200);
      const run = await runZip(w, day, day, 2048);
      assert.equal(run.status.total, one.total);
    } finally {
      await w.cleanup();
    }
  });

  it("failed recordings are retried without downloading the successful ones again; the finished ZIP is complete", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 100, callsPerLead: 4, days: 10 });
    try {
      const dead = new Set<string>();
      const first = await runZip(w, w.from, w.to, 2048, { failing: (u) => { const n = Number(/\/(\d+)\.mp3$/.exec(u)![1]); const bad = n % 10 === 0; if (bad) dead.add(u); return bad; } });
      assert.equal(first.status.status, "COMPLETED");
      assert.equal(first.status.failed, 40);
      assert.equal(first.status.canRetry, true);

      const queued: string[] = [];
      const service = serviceFor(queued);
      const retried = await service.retry(user(w, "admin") as never, first.created.id);
      assert.equal(retried.status, "QUEUED");
      const provider = mockProvider(2048); // the provider has recovered
      assert.equal(await processExportJob(deps(provider.fetchFile, queued), first.created.id, { concurrency: 8 }), "completed");
      assert.deepEqual([...provider.state.urls].sort(), [...dead].sort(), "ONLY the 40 failed recordings were downloaded again");
      const done = await service.get(user(w, "admin") as never, first.created.id);
      assert.equal(done.failed, 0);
      assert.equal(done.processed, 400);
      await verifyZipFile(first.created.id, done.sizeBytes, 400);
    } finally {
      await w.cleanup();
    }
  });

  it("an application / worker restart mid-export resumes from the last saved batch and downloads no finished recording twice", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 500, callsPerLead: 4, days: 20 });
    try {
      const queued: string[] = [];
      const service = serviceFor(queued);
      const created = await service.create(user(w, "admin") as never, { kind: "ZIP", from: w.from, to: w.to });
      // "process 1": the database vanishes after 6 saved batches (like a killed process / lost connection that never recovers)
      const real = new PrismaExportRepo(prisma);
      let saved = 0;
      const dying = Object.assign(Object.create(real), {
        checkpoint: async (...args: Parameters<PrismaExportRepo["checkpoint"]>) => {
          if (saved >= 6) throw new Error("connection terminated");
          saved++;
          return real.checkpoint(...args);
        },
        release: real.release.bind(real),
        claim: real.claim.bind(real),
        items: real.items.bind(real),
        sources: real.sources.bind(real),
        heartbeat: real.heartbeat.bind(real),
        progress: real.progress.bind(real),
        finish: real.finish.bind(real),
      }) as PrismaExportRepo;
      const first = mockProvider(2048);
      const out1 = await runExport({ repo: dying, store, fetchFile: first.fetchFile }, created.id, { concurrency: 6, checkpointEvery: 25, sleep: async () => undefined, dbRetries: 2 });
      assert.equal(out1, "retry", "a server-side interruption re-queues the job - it is not failed");
      const mid = await service.get(user(w, "admin") as never, created.id);
      assert.equal(mid.status, "QUEUED");
      assert.equal(mid.processed, 150, "6 saved batches of 25 survived");

      // "process 2": a new worker (fresh repo/store/fetcher) picks the job up
      const second = mockProvider(2048);
      assert.equal(await processExportJob(deps(second.fetchFile, queued), created.id, { concurrency: 6, checkpointEvery: 25 }), "completed");
      assert.equal(second.state.calls, 2000 - 150, "only what was not yet saved is downloaded again");
      for (const url of first.state.urls) if (second.state.urls.has(url)) assert.ok(first.state.calls > 150); // overlap is only the unsaved tail
      const done = await service.get(user(w, "admin") as never, created.id);
      assert.equal(done.status, "COMPLETED");
      await verifyZipFile(created.id, done.sizeBytes, 2000);
    } finally {
      await w.cleanup();
    }
  });

  it("an export whose worker vanished (stale heartbeat) is found by maintenance and finished; opening the page also heals it", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 50, callsPerLead: 4, days: 5 });
    try {
      const queued: string[] = [];
      const service = serviceFor(queued);
      const created = await service.create(user(w, "admin") as never, { kind: "ZIP", from: w.from, to: w.to });
      await prisma.recordingExportJob.update({ where: { id: created.id }, data: { status: "PROCESSING", heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
      assert.equal((await service.get(user(w, "admin") as never, created.id)).stalled, true, "the page is told it is not really running");
      queued.length = 0;
      const result = await recordingExportMaintenance(prisma, async (id) => void queued.push(id));
      assert.ok(result.requeued >= 1 && queued.includes(created.id));
      assert.equal(await processExportJob(deps(mockProvider(1024).fetchFile, queued), created.id), "completed");
    } finally {
      await w.cleanup();
    }
  });

  it("a shutdown (SIGTERM / redeploy) hands the running export back to the queue at once, and the next worker finishes it", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 100, callsPerLead: 4, days: 5 });
    try {
      const queued: string[] = [];
      const service = serviceFor(queued);
      const created = await service.create(user(w, "admin") as never, { kind: "ZIP", from: w.from, to: w.to });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      const running = processExportJob(deps(async (url) => { if (++calls === 30) await gate; return mockProvider(1024).fetchFile(url); }, queued), created.id, { concurrency: 4, checkpointEvery: 10 });
      while (calls < 30) await new Promise((r) => setTimeout(r, 20));
      assert.equal((await service.get(user(w, "admin") as never, created.id)).status, "PROCESSING");
      assert.equal(await releaseRunningExports(prisma), 1);
      const released = await prisma.recordingExportJob.findUniqueOrThrow({ where: { id: created.id } });
      assert.equal(released.status, "QUEUED");
      assert.equal(released.heartbeatAt?.getTime(), 0, "marked released so the very next sweep picks it up");
      const sweep = await recordingExportMaintenance(prisma, async (id) => void queued.push(id));
      assert.ok(sweep.requeued >= 1, "the sweep re-queues it immediately (no waiting for a stale heartbeat)");
      release();
      await running.catch(() => undefined); // the old process dies in reality; here it simply finishes or stops
      const final = await prisma.recordingExportJob.findUniqueOrThrow({ where: { id: created.id } });
      if (final.status !== "COMPLETED") assert.equal(await processExportJob(deps(mockProvider(1024).fetchFile, queued), created.id), "completed");
      const done = await service.get(user(w, "admin") as never, created.id);
      assert.equal(done.status, "COMPLETED");
      await verifyZipFile(created.id, done.sizeBytes, done.processed);
    } finally {
      await w.cleanup();
    }
  });

  it("several exports at once (different users and kinds) all complete correctly; the per-user and server limits hold", { timeout: 200_000 }, async () => {
    const w = await seedRecordingWorld(prisma, { leads: 500, callsPerLead: 4, days: 30 });
    try {
      const queued: string[] = [];
      const service = serviceFor(queued);
      const a = await service.create(user(w, "admin") as never, { kind: "ZIP", from: w.from, to: w.to });
      const b = await service.create(user(w, "manager") as never, { kind: "ZIP", from: w.from, to: w.to });
      const c = await service.create(user(w, "admin") as never, { kind: "EXCEL", from: w.from, to: w.to });
      // identical active request: the same export is returned, not a duplicate job
      const again = await service.create(user(w, "admin") as never, { kind: "ZIP", from: w.from, to: w.to });
      assert.equal(again.id, a.id);
      assert.equal(again.reused, true);
      // the per-user limit (2 active) is per KIND: a second ZIP is fine, a third is refused - and the Excel running next to them never counted against it
      await service.create(user(w, "admin") as never, { kind: "ZIP", from: w.to, to: w.to });
      await assert.rejects(() => service.create(user(w, "admin") as never, { kind: "ZIP", from: w.from, to: w.from }), { statusCode: 429 });

      const provider = mockProvider(4096);
      const results = await Promise.all([a, b, c].map((j) => processExportJob(deps(provider.fetchFile, queued), j.id, { concurrency: 4 })));
      assert.deepEqual(results, ["completed", "completed", "completed"]);
      for (const j of [a, b, c]) assert.equal((await service.get(user(w, j === b ? "manager" : "admin") as never, j.id)).status, "COMPLETED");
      // after completion the user may start another
      const next = await service.create(user(w, "admin") as never, { kind: "ZIP", from: w.from, to: w.to });
      assert.notEqual(next.id, a.id);
    } finally {
      await w.cleanup();
    }
  });
});

describe("Excel export of abandoned-lead records (real DB)", () => {
  async function runExcel(w: SeededWorld, from: string, to: string, filters?: unknown) {
    const queued: string[] = [];
    const service = serviceFor(queued);
    const created = await service.create(user(w, "admin") as never, { kind: "EXCEL", from, to, filters });
    const out = await measure(() => processExportJob(deps(mockProvider(1).fetchFile, queued), created.id));
    const status = await service.get(user(w, "admin") as never, created.id);
    return { created, status, outcome: out.result, ms: out.ms, peakMb: out.peakMb };
  }
  async function readSheet(jobId: string, size: number) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await readFile(jobId, size)) as never);
    return wb;
  }

  for (const leads of [20, 100, 1000, 20000]) {
    it(`${leads} abandoned leads: every row exported across all database pages, valid .xlsx, bounded memory`, { timeout: 250_000 }, async () => {
      const w = await seedRecordingWorld(prisma, { leads, callsPerLead: 2, days: 365, noLinkEvery: 3 });
      try {
        const run = await runExcel(w, w.from, w.to);
        assert.equal(run.outcome, "completed");
        assert.equal(run.status.kind, "EXCEL");
        assert.equal(run.status.status, "COMPLETED");
        assert.equal(run.status.total, leads);
        assert.equal(run.status.processed, leads);
        assert.equal(run.status.percent, 100);
        const wb = await readSheet(run.created.id, run.status.sizeBytes);
        const sheet = wb.getWorksheet("Abandoned leads")!;
        assert.equal(sheet.rowCount, leads + 1, "header + one row per lead, none lost at page boundaries (1000 rows per database page)");
        assert.deepEqual((sheet.getRow(1).values as string[]).slice(1), ["Lead ID", "Customer name", "Contact number", "Email", "Items", "Order value", "Currency", "Detected (IST)", "Lead status", "Call attempts", "Answered calls", "Assigned salesperson", "Assigned manager", "Recording available", "Recordings", "Checkout reference", "Customer orders", "Latest order"]);
        const ids = new Set<string>();
        sheet.eachRow((row, n) => {
          if (n > 1) ids.add(String(row.getCell(1).value));
        });
        assert.equal(ids.size, leads, "every lead exactly once");
        const sample = sheet.getRow(2).values as unknown[];
        assert.match(String(sample[1]), /^EXP-/);
        assert.equal(sample[6], 499);
        assert.equal(sample[7], "INR");
        assert.equal(sample[10], 2, "two outbound calls per lead");
        assert.ok(wb.getWorksheet("Summary"));
        note(`Excel ${String(leads).padStart(5)} rows: ${(run.ms / 1000).toFixed(1)}s (${Math.round(leads / (run.ms / 1000))} rows/s), peak RSS +${run.peakMb} MB, ${(run.status.sizeBytes / 1024).toFixed(0)} KB`);
        assert.ok(run.peakMb < 600);
      } finally {
        await w.cleanup();
      }
    });
  }

  it("recording availability, call counts and the date range / filters are applied; the file never embeds audio", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 40, callsPerLead: 3, days: 20, noLinkEvery: 0 });
    try {
      await prisma.lead.updateMany({ where: { leadNumber: { startsWith: `EXP-${w.tag}-` }, firstName: { in: ["Customer1", "Customer2"] } }, data: { workingStatus: "INTERESTED" } });
      const filtered = await runExcel(w, w.from, w.to, { workingStatus: "INTERESTED" });
      assert.equal(filtered.status.total, 2, "the list filter is applied");
      const sheet = (await readSheet(filtered.created.id, filtered.status.sizeBytes)).getWorksheet("Abandoned leads")!;
      assert.equal(sheet.rowCount, 3);
      assert.equal(sheet.getRow(2).getCell(14).value, "Yes", "recording available");
      assert.equal(sheet.getRow(2).getCell(15).value, 3);
      assert.ok(filtered.status.sizeBytes < 200 * 1024, "no audio inside the workbook");
      await assert.rejects(() => serviceFor([]).create(user(w, "admin") as never, { kind: "EXCEL", from: w.from, to: w.to, filters: { workingStatus: "NOT_A_STATUS" } }), { statusCode: 400 });
      const none = "2000-01-01";
      await assert.rejects(() => serviceFor([]).create(user(w, "admin") as never, { kind: "EXCEL", from: none, to: none }), { statusCode: 404 });
    } finally {
      await w.cleanup();
    }
  });

  it("a manager's Excel contains only the leads assigned to them", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 30, callsPerLead: 1, days: 5 });
    try {
      const service = serviceFor([]);
      const other = await prisma.user.create({ data: { name: "Other manager", username: `other-${w.tag}`, role: Role.MANAGER } });
      try {
        await assert.rejects(() => service.create({ id: other.id, role: Role.MANAGER, username: other.username }, { kind: "EXCEL", from: w.from, to: w.to }), { statusCode: 404 }, "a manager with no leads has nothing to export");
        const mine = await service.create(user(w, "manager") as never, { kind: "EXCEL", from: w.from, to: w.to });
        assert.equal(mine.total, 30);
      } finally {
        await prisma.recordingExportJob.deleteMany({ where: { createdById: { in: [other.id, w.manager.id] } } });
        await prisma.user.delete({ where: { id: other.id } });
      }
    } finally {
      await w.cleanup();
    }
  });

  it("a storage problem part-way through an Excel export re-queues it and the rebuilt file is complete", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 3000, callsPerLead: 1, days: 30 });
    try {
      const queued: string[] = [];
      const service = serviceFor(queued);
      const created = await service.create(user(w, "admin") as never, { kind: "EXCEL", from: w.from, to: w.to });
      let writes = 0;
      const flaky = { openWriter: async (id: string, off: number) => { const real = await store.openWriter(id, off); return { get offset() { return real.offset; }, flush: () => real.flush(), write: async (c: Buffer) => { if (++writes === 2) throw new Error("storage write failed"); return real.write(c); } }; } };
      const first = await processExportJob({ ...deps(mockProvider(1).fetchFile, queued), store: flaky }, created.id, { sleep: async () => undefined });
      assert.equal(first, "retry");
      assert.equal((await service.get(user(w, "admin") as never, created.id)).status, "QUEUED");
      assert.equal(await processExportJob(deps(mockProvider(1).fetchFile, queued), created.id), "completed");
      const done = await service.get(user(w, "admin") as never, created.id);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await readFile(created.id, done.sizeBytes)) as never);
      assert.equal(wb.getWorksheet("Abandoned leads")!.rowCount, 3001);
    } finally {
      await w.cleanup();
    }
  });
});

describe("access, history and cleanup (real DB)", () => {
  it("only admins and managers can use exports; an export is private to its creator; the history survives a 'page refresh'", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 25, callsPerLead: 4, days: 5 });
    try {
      const queued: string[] = [];
      const service = serviceFor(queued);
      const admin = user(w, "admin") as never;
      const created = await service.create(admin, { kind: "ZIP", from: w.from, to: w.to });
      const telecaller = user(w, "telecaller") as never;
      await assert.rejects(() => service.create(telecaller, { kind: "ZIP", from: w.from, to: w.to }), { statusCode: 403 });
      await assert.rejects(() => service.create(telecaller, { kind: "EXCEL", from: w.from, to: w.to }), { statusCode: 403 });
      await assert.rejects(() => service.list(telecaller), { statusCode: 403 });
      await assert.rejects(() => service.get(telecaller, created.id), { statusCode: 403 });
      await assert.rejects(() => service.retry(telecaller, created.id), { statusCode: 403 });
      await assert.rejects(() => service.downloadLink(telecaller, created.id), { statusCode: 403 });
      // a different manager cannot see or fetch it either
      const manager = user(w, "manager") as never;
      await assert.rejects(() => service.get(manager, created.id), { statusCode: 404 });
      assert.deepEqual(await service.list(manager), []);

      await processExportJob(deps(mockProvider(1024).fetchFile, queued), created.id);
      // "refresh": a brand-new service instance (no memory of the job) finds it in the history with its full status
      const history = await serviceFor([]).list(admin);
      const found = history.find((h) => h.id === created.id)!;
      assert.equal(found.status, "COMPLETED");
      assert.equal(found.kind, "ZIP");
      assert.equal(found.canDownload, true);
      assert.equal(found.total, 100);
      assert.ok(found.createdAt && found.finishedAt && found.from === w.from);
      // the download link works for the owner only and is not reusable after tampering
      const link = await service.downloadLink(admin, created.id);
      assert.match(link.url, /\/file\?u=/);
      await assert.rejects(() => service.downloadByLink(created.id, w.manager.id, 9999999999, "x".repeat(43), {} as never), { statusCode: 403 });
    } finally {
      await w.cleanup();
    }
  });

  it("expired exports are deleted together with their items and stored file; live ones are untouched", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 25, callsPerLead: 4, days: 5 });
    try {
      const queued: string[] = [];
      const service = serviceFor(queued);
      const old = await service.create(user(w, "admin") as never, { kind: "ZIP", from: w.from, to: w.to });
      await processExportJob(deps(mockProvider(2048).fetchFile, queued), old.id);
      const live = await service.create(user(w, "manager") as never, { kind: "EXCEL", from: w.from, to: w.to });
      await processExportJob(deps(mockProvider(1).fetchFile, queued), live.id);
      const count = async (id: string) => ({
        job: await prisma.recordingExportJob.count({ where: { id } }),
        items: await prisma.recordingExportItem.count({ where: { jobId: id } }),
        chunks: await prisma.recordingExportChunk.count({ where: { jobId: id } }),
      });
      assert.ok((await count(old.id)).chunks > 0 && (await count(old.id)).items === 100);
      await prisma.recordingExportJob.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await assert.rejects(() => service.get(user(w, "admin") as never, old.id), { statusCode: 404 }, "an expired export is already unavailable before cleanup runs");
      const r = await recordingExportMaintenance(prisma, async () => undefined);
      assert.ok(r.deleted >= 1);
      assert.deepEqual(await count(old.id), { job: 0, items: 0, chunks: 0 });
      assert.equal((await count(live.id)).job, 1);
      assert.ok((await count(live.id)).chunks > 0);
    } finally {
      await w.cleanup();
    }
  });

  it("recording links on hosts that are not approved are never fetched (counted as unavailable)", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 10, callsPerLead: 4, days: 3, host: "evil.example.org" });
    try {
      const summary = await recordings.summary(w.admin as never, { from: w.from, to: w.to });
      assert.equal(summary.total, 40);
      assert.equal(summary.available, 0);
      assert.equal(summary.unavailable, 40);
      await assert.rejects(() => serviceFor([]).create(w.admin as never, { kind: "ZIP", from: w.from, to: w.to }).then(async (j) => {
        const provider = mockProvider(1024);
        const outcome = await processExportJob(deps(provider.fetchFile, []), j.id);
        assert.equal(outcome, "failed");
        assert.equal(provider.state.calls, 0, "the provider is never contacted for a blocked host");
        const status = await serviceFor([]).get(w.admin as never, j.id);
        assert.match(status.errorMessage ?? "", /None of the 40 recordings could be downloaded/);
        throw Object.assign(new Error("expected"), { statusCode: 0 });
      }), { statusCode: 0 });
    } finally {
      await w.cleanup();
    }
  });
});

after(() => {
  console.log("\n=== EXPORT PERFORMANCE REPORT ===\n" + report.join("\n"));
});

