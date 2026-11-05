import assert from "node:assert/strict";
import { test } from "node:test";
import { Role } from "../../../generated/prisma/enums.js";
import { abandonmentSearchWhere, canAccessRecordings } from "./abandonment.filters.js";
import {
  AbandonmentRecordingsService,
  assertFetchableRecordingUrl,
  crc32,
  planRecordings,
  recordingFileName,
  recordingRangeBounds,
  recordingStamp,
  ZipWriter,
  type RecordingRow,
} from "./abandonment.recordings.js";
import type { DbClient } from "@/lib/leadScope.js";

const row = (over: Partial<RecordingRow> = {}): RecordingRow => ({
  callId: "11111111-2222-3333-4444-555555555555",
  recordingUrl: "https://rec.callerdesk.io/a.mp3",
  expiresAt: null,
  at: new Date("2026-11-05T08:47:00.000Z"),
  leadNumber: "LEAD-1",
  customerName: "Rahul Sharma",
  ...over,
});

test("only admin and manager may access recordings", () => {
  assert.equal(canAccessRecordings(Role.ADMIN), true);
  assert.equal(canAccessRecordings(Role.MANAGER), true);
  for (const role of [Role.SALESPERSON, Role.HR, Role.RECRUITER]) assert.equal(canAccessRecordings(role), false, role);
});

test("recording service refuses a telecaller / HR before touching the database", async () => {
  const db = new Proxy({}, { get: () => assert.fail("database must not be reached") }) as unknown as DbClient;
  const service = new AbandonmentRecordingsService(db);
  for (const role of [Role.SALESPERSON, Role.HR]) {
    const user = { id: "u", role, username: "x" };
    await assert.rejects(() => service.summary(user, { from: "2026-11-05", to: "2026-11-05" }), { statusCode: 403 });
    await assert.rejects(() => service.single(user, "11111111-2222-3333-4444-555555555555"), { statusCode: 403 });
  }
});

test("file names carry lead, customer and recording date, and are filesystem safe", () => {
  assert.equal(recordingStamp(new Date("2026-11-05T08:47:00.000Z")), "2026-11-05_1417"); // IST
  const name = recordingFileName({ leadNumber: "LEAD-1", customerName: "Rahul / Sharma?", at: new Date("2026-11-05T08:47:00.000Z"), callId: "abcdef12-0000-0000-0000-000000000000", extension: "mp3" });
  assert.equal(name, "LEAD-1_Rahul_Sharma_2026-11-05_1417_abcdef12.mp3");
});

test("planRecordings skips unavailable ones and removes duplicates", () => {
  const rows = [
    row({ callId: "a" }),
    row({ callId: "b", recordingUrl: "https://rec.callerdesk.io/a.mp3" }), // same recording
    row({ callId: "c", recordingUrl: null }),
    row({ callId: "d", recordingUrl: "http://insecure.callerdesk.io/x.mp3" }),
    row({ callId: "e", recordingUrl: "https://rec.callerdesk.io/e.mp3", expiresAt: new Date(0) }),
    row({ callId: "f", recordingUrl: "https://rec.callerdesk.io/f.mp3" }),
  ];
  const plan = planRecordings(rows);
  assert.deepEqual(plan.usable.map((r) => r.callId), ["a", "f"]);
  assert.equal(plan.unavailable.length, 3);
  assert.equal(plan.duplicates, 1);
});

test("only public https recording URLs are fetched", () => {
  assert.doesNotThrow(() => assertFetchableRecordingUrl("https://rec.callerdesk.io/a.mp3"));
  for (const bad of ["http://rec.example.com/a.mp3", "https://localhost/a", "https://127.0.0.1/a", "https://10.1.2.3/a", "https://192.168.0.5/a", "https://169.254.169.254/latest", "file:///etc/passwd", "nonsense"]) {
    assert.throws(() => assertFetchableRecordingUrl(bad), bad);
  }
});

test("date range is inclusive of the To day in IST and validated", () => {
  const { gte, lt } = recordingRangeBounds({ from: "2026-11-05", to: "2026-11-06" });
  assert.equal(gte.toISOString(), "2026-11-04T18:30:00.000Z");
  assert.equal(lt.toISOString(), "2026-11-06T18:30:00.000Z");
  assert.throws(() => recordingRangeBounds({ from: "2026-11-07", to: "2026-11-06" }), { statusCode: 400 });
  assert.throws(() => recordingRangeBounds({ from: "", to: "2026-11-06" }), { statusCode: 400 });
  assert.throws(() => recordingRangeBounds({ from: "2026-13-45", to: "2026-13-46" }), { statusCode: 400 });
});

test("ZipWriter produces a readable archive", async () => {
  const chunks: Buffer[] = [];
  const zip = new ZipWriter((c) => void chunks.push(c));
  await zip.add("a.txt", Buffer.from("hello"));
  await zip.add("b.txt", Buffer.from("world!"));
  await zip.finish();
  const buf = Buffer.concat(chunks);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  assert.equal(buf.readUInt16LE(end + 10), 2); // two entries
  // Round-trip with jszip (present in node_modules as a transitive dependency).
  const { default: JSZip } = await import("jszip");
  const loaded = await JSZip.loadAsync(buf);
  assert.equal(await loaded.file("a.txt")!.async("string"), "hello");
  assert.equal(await loaded.file("b.txt")!.async("string"), "world!");
});

test("search covers name, phone (any format), and order id on the whole result set", () => {
  const json = (s: string) => JSON.stringify(abandonmentSearchWhere(s));
  const byName = json("rahul sharma");
  assert.match(byName, /firstName/);
  assert.equal((abandonmentSearchWhere("rahul sharma").AND as unknown[]).length, 2); // every word must match
  const phone = abandonmentSearchWhere("+91 98765 43210");
  assert.equal((phone.AND as unknown[]).length, 1); // one phone number, not three words
  assert.match(JSON.stringify(phone), /"contains":"9876543210"/); // last 10 digits
  const order = json("#AWL103746");
  assert.match(order, /orderNumber/);
  assert.match(order, /externalNumber/);
  assert.match(order, /referenceId/);
  assert.match(order, /"contains":"AWL103746"/); // "#" stripped
});
