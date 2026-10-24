// WhatsApp Report Automation against the real schema. Every service test runs in ONE rolled-back transaction on the isolated test database; WhatsApp is a fake sender (no provider is ever called,
// nothing is sent to anyone). The route-level tests use real signed tokens against the real router and only make requests that are refused (or only read) before any data is touched.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import express from "express";
import type { AddressInfo } from "node:net";
import ExcelJS from "exceljs";
import { prisma } from "../../lib/prisma.js";
import { signToken } from "../../lib/jwt.js";
import { errorHandler } from "../../middlewares/errorHandler.js";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import ReportAutomationService, { customerWindowOpen, MAX_ATTEMPTS, STALE_SENDING_MS, SCHEDULER_STALE_MS, maskPhone } from "./report-automation.service.js";
import { createWhatsAppReportDocumentSender, createWhatsAppReportSender, explainDocumentError, ReportSendRejected, type ReportDocumentInput, type ReportSendInput } from "./report-automation.sender.js";
import { validateConfigInput, type ConfigInput } from "./report-automation.validators.js";
import { buildReportXlsx, safeCell } from "./report-automation.xlsx.js";
import { applyReportDeliveryStatus } from "./report-automation.status.js";
import type { ReportSources } from "./report-automation.report.js";
import reportRoutes, { cronRouter } from "./report-automation.routes.js";
import WhatsAppService from "../whatsapp/whatsapp.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const IST = "Asia/Kolkata";
const asUser = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });
const at = (iso: string) => new Date(iso);
// 18:15 IST on 23 Oct 2026 = 12:45 UTC
const T_1814 = "2026-10-23T12:44:00Z";
const T_1815 = "2026-10-23T12:45:00Z";
const A = "+919876543210";
const B = "+919811122233";
const C = "+14155550123";

const people = [{ id: "t1", name: "Asha", leads: 10, contacted: 8, interested: 4, converted: 2, calls: 30, connected: 20, talkTimeSec: 3600, orders: 2, revenue: 1298 }];
const sources: ReportSources = { overview: async () => people as never, cancelledByUser: async () => new Map(), pendingFollowUps: async () => new Map() };

/** A fake WhatsApp, per recipient: records every send, and can refuse (a definite "no") or time out (no answer) for chosen numbers. */
function fakeWhatsApp() {
  const state = { sent: [] as ReportSendInput[], modes: {} as Record<string, "ok" | "refuse" | "timeout">, calls: [] as string[] };
  const send = async (input: ReportSendInput) => {
    state.calls.push(input.recipient);
    const mode = state.modes[input.recipient] ?? "ok";
    if (mode === "refuse") throw new ReportSendRejected("Template not approved by Meta");
    if (mode === "timeout") throw new Error("socket hang up");
    state.sent.push(input);
    return { providerMessageId: `wamid.${state.sent.length}.${input.recipient.slice(-4)}`, provider: "META" };
  };
  // the Excel document: records each file; can refuse or time out per number; the media is "uploaded" once and reused
  const docs = { calls: [] as string[], files: [] as { filename: string; size: number; recipient: string; caption: string }[], modes: {} as Record<string, "ok" | "refuse" | "timeout">, uploads: 0 };
  const sendDocument = async (input: ReportDocumentInput) => {
    docs.calls.push(input.recipient);
    const mode = docs.modes[input.recipient] ?? "ok";
    if (mode === "refuse") throw new ReportSendRejected("WhatsApp only delivers a file inside 24 hours of the recipient's last message");
    if (mode === "timeout") throw new Error("socket hang up");
    const mediaId = input.mediaId ?? `media.${++docs.uploads}`;
    docs.files.push({ filename: input.filename, size: input.bytes.length, recipient: input.recipient, caption: input.caption });
    return { providerMessageId: `wamid.doc.${docs.files.length}`, mediaId, provider: "META" };
  };
  // the detailed free-form text, and the recipient's 24-hour window (open by default; tests close it per number)
  const details = { calls: [] as string[], texts: [] as { recipient: string; text: string }[], modes: {} as Record<string, "ok" | "refuse" | "timeout">, closed: new Set<string>() };
  const sendDetail = async (input: { recipient: string; text: string }) => {
    details.calls.push(input.recipient);
    const mode = details.modes[input.recipient] ?? "ok";
    if (mode === "refuse") throw new ReportSendRejected("Meta refused the text");
    if (mode === "timeout") throw new Error("socket hang up");
    details.texts.push(input);
    return { providerMessageId: `wamid.txt.${details.texts.length}`, provider: "META" };
  };
  const windowOpen = async (phone: string) => !details.closed.has(phone);
  return { state, send, sendDocument, docs, sendDetail, windowOpen, details };
}

async function world(tx: Prisma.TransactionClient, start = T_1815) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const manager = await tx.user.create({ data: { name: "Manager", username: `m-${uid()}`, role: Role.MANAGER } });
  const clock = { now: new Date(start) };
  const wa = fakeWhatsApp();
  const mk = () => new ReportAutomationService(tx, { now: () => clock.now, sources, send: wa.send, sendDocument: wa.sendDocument, sendDetail: wa.sendDetail, windowOpen: wa.windowOpen });
  const svc = mk();
  const config = { enabled: true, recipients: [{ name: "Owner", phone: A }, { name: "Ops", phone: B }], sendTime: "18:15", timezone: IST, reportFor: "TODAY" as const, templateName: "daily_team_report", languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, includedUserIds: [] as string[], sendText: true, sendExcel: false };
  wa.details.closed.add(A).add(B).add(C); // windows are CLOSED by default (the template is then the way to reach them); tests of the free-form parts open them
  return { admin, manager, clock, wa, svc, mk, config, as: (u: typeof admin, r: Role) => asUser(u, r) };
}
const runOf = (tx: Prisma.TransactionClient, kind: "SCHEDULED" | "TEST" = "SCHEDULED") => tx.reportDelivery.findFirstOrThrow({ where: { kind }, include: { recipientResults: true }, orderBy: { createdAt: "desc" } });
const byPhone2 = (run: { recipientResults: { phone: string; status: string; docStatus: string }[] }) => Object.fromEntries(run.recipientResults.map((r) => [r.phone, r]));
const byPhone = (run: { recipientResults: { phone: string; status: string; attempts: number; error: string | null; providerMessageId: string | null; nextAttemptAt: Date | null; deliveredAt: Date | null; readAt: Date | null }[] }) => Object.fromEntries(run.recipientResults.map((r) => [r.phone, r]));

describe("authorization", () => {
  it("every endpoint refuses SALESPERSON / HR / RECRUITER / no token before touching any data, the service refuses them too, and Admin / Manager get through", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/report-automation/cron", cronRouter);
    app.use("/api/report-automation", reportRoutes);
    app.use(errorHandler);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/report-automation`;
      const call = (path: string, method: string, token?: string, body?: unknown) =>
        fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const id = uid();
      const endpoints: [string, string, unknown?][] = [["/config", "GET"], ["/config", "PUT", {}], ["/preview", "GET"], ["/test-send", "POST", { confirm: true }], ["/deliveries", "GET"], ["/status", "GET"], [`/deliveries/${id}/retry`, "POST", {}]];
      for (const role of [Role.SALESPERSON, Role.HR, Role.RECRUITER]) {
        const token = signToken({ sub: uid(), role, username: "x" } as never);
        for (const [path, method, body] of endpoints) assert.equal((await call(path, method, token, body)).status, 403, `${role} ${method} ${path}`);
      }
      for (const [path, method, body] of endpoints) assert.equal((await call(path, method, undefined, body)).status, 401, `anonymous ${method} ${path}`);
      for (const role of [Role.ADMIN, Role.MANAGER]) {
        const token = signToken({ sub: uid(), role, username: "x" } as never);
        assert.equal((await call("/config", "PUT", token, { enabled: "nope" })).status, 400, role);
        assert.equal((await call("/test-send", "POST", token, {})).status, 400, `${role} test-send without confirmation`);
        assert.equal((await call("/deliveries/not-a-uuid/retry", "POST", token, {})).status, 400, `${role} retry with a malformed id`);
        assert.equal((await call(`/deliveries/${id}/retry`, "POST", token, {})).status, 404, `${role} retry of a delivery that is not theirs`);
        assert.equal((await call("/status", "GET", token)).status, 200, `${role} status`);
      }
      // the external trigger: disabled (404) with no secret configured, 401 for a wrong secret, 200 + counts only for the right one
      delete process.env.REPORT_CRON_SECRET;
      assert.equal((await call("/cron/tick", "POST")).status, 404);
      process.env.REPORT_CRON_SECRET = "test-cron-secret-not-real";
      const cron = (secret?: string) => fetch(base + "/cron/tick", { method: "POST", headers: secret ? { "x-cron-secret": secret } : {} });
      assert.equal((await cron()).status, 401);
      assert.equal((await cron("wrong-secret-of-another-length")).status, 401);
      assert.equal((await cron("test-cron-secret-xxxxxxxxx")).status, 401, "same length, different value");
      const ok = await cron("test-cron-secret-not-real");
      assert.equal(ok.status, 200);
      assert.deepEqual(Object.keys(((await ok.json()) as { data: object }).data).sort(), ["checked", "started"], "counts only");
    } finally {
      delete process.env.REPORT_CRON_SECRET;
      server.close();
    }
    await inRollback(async (tx) => {
      const w = await world(tx);
      for (const role of [Role.SALESPERSON, Role.HR, Role.RECRUITER]) {
        const u = w.as(w.admin, role);
        await assert.rejects(() => w.svc.getConfig(u), /Forbidden/);
        await assert.rejects(() => w.svc.saveConfig(u, w.config), /Forbidden/);
        await assert.rejects(() => w.svc.preview(u), /Forbidden/);
        await assert.rejects(() => w.svc.sendTest(u), /Forbidden/);
        await assert.rejects(() => w.svc.history(u, 1, 20), /Forbidden/);
        await assert.rejects(() => w.svc.status(u), /Forbidden/);
        await assert.rejects(() => w.svc.retryRecipient(u, uid()), /Forbidden/);
      }
    });
  });

  it("each user has their OWN automation, recipients and history: a manager never sees, changes or retries the admin's", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      const m = w.as(w.manager, Role.MANAGER);
      await w.svc.saveConfig(a, w.config);
      assert.deepEqual((await w.svc.getConfig(m)).recipients, []);
      w.wa.state.modes[A] = "refuse";
      const run = await w.svc.sendTest(a);
      assert.equal((await w.svc.history(a, 1, 20)).items.length, 1);
      assert.equal((await w.svc.history(m, 1, 20)).items.length, 0);
      await assert.rejects(() => w.svc.retryRecipient(m, run.recipients.find((r) => r.status === "FAILED")!.id), /Delivery not found/);
    });
  });
});

describe("recipients", () => {
  it("saves a list with optional names, in order; reloads it exactly; edits, renames and removes individual numbers", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      assert.deepEqual((await w.svc.getConfig(a)).recipients, []);
      const saved = await w.svc.saveConfig(a, { ...w.config, recipients: [{ name: "Owner", phone: A }, { phone: B }, { name: "Intl", phone: C }] });
      assert.deepEqual(saved.recipients.map((r) => [r.name, r.phone]), [["Owner", A], [null, B], ["Intl", C]]);
      // rename one, drop one, reorder
      const next = await w.svc.saveConfig(a, { ...w.config, recipients: [{ name: "Intl (renamed)", phone: C }, { name: "Owner", phone: A }] });
      assert.deepEqual(next.recipients.map((r) => [r.name, r.phone]), [["Intl (renamed)", C], ["Owner", A]]);
      assert.deepEqual((await w.svc.getConfig(a)).recipients.map((r) => r.phone), [C, A]);
      assert.equal((await tx.reportAutomation.findUniqueOrThrow({ where: { ownerId: w.admin.id } })).recipient, C, "the legacy single-number column follows the first recipient");
      await w.svc.saveConfig(a, { ...w.config, enabled: false, recipients: [] });
      assert.deepEqual((await w.svc.getConfig(a)).recipients, []);
    });
  });

  it("the EXISTING single-number configuration and delivery history are migrated by the migration's own SQL - nothing lost, and running it again adds nothing", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      // what the database looked like before this change: a single `recipient`, and old-style delivery rows with no per-recipient rows
      const auto = await tx.reportAutomation.create({ data: { ownerId: w.admin.id, enabled: false, recipient: A, sendTime: "18:15", timezone: IST, templateName: null } });
      const sent = await tx.reportDelivery.create({ data: { automationId: auto.id, kind: "SCHEDULED", reportDate: "2026-10-22", dedupeKey: `${auto.id}:2026-10-22`, recipient: A, status: "SENT", attempts: 1, providerMessageId: "wamid.OLD", sentAt: at("2026-10-22T12:46:00Z") } });
      const failed = await tx.reportDelivery.create({ data: { automationId: auto.id, kind: "TEST", reportDate: "2026-10-22", recipient: A, status: "FAILED", attempts: 1, error: "Template not approved by Meta" } });
      const sql = fs.readFileSync(new URL("../../../prisma/migrations/20261024000000_report_automation_recipients/migration.sql", import.meta.url), "utf8");
      const dataPart = sql.slice(sql.indexOf("-- DataMigration: the existing single configured number"));
      const statements = dataPart.split(/;\s*\n/).map((s) => s.replace(/^--.*$/gm, "").trim()).filter(Boolean);
      assert.equal(statements.length, 2);
      for (const s of statements) await tx.$executeRawUnsafe(s);
      for (const s of statements) await tx.$executeRawUnsafe(s); // a second run changes nothing

      const cfg = await w.svc.getConfig(w.as(w.admin, Role.ADMIN));
      assert.deepEqual(cfg.recipients.map((r) => [r.name, r.phone]), [[null, A]]);
      assert.deepEqual([cfg.sendTime, cfg.timezone, cfg.enabled], ["18:15", IST, false], "the other settings are untouched");
      const history = await w.svc.history(w.as(w.admin, Role.ADMIN), 1, 20);
      assert.equal(history.items.length, 2);
      const oldSent = history.items.find((i) => i.id === sent.id)!;
      assert.deepEqual(oldSent.recipients.map((r) => [r.phone, r.status, r.attempts, r.providerMessageId]), [[maskPhone(A), "SENT", 1, "wamid.OLD"]]);
      const oldFailed = history.items.find((i) => i.id === failed.id)!;
      assert.deepEqual([oldFailed.recipients[0]!.status, oldFailed.recipients[0]!.error], ["FAILED", "Template not approved by Meta"]);
      assert.equal(await tx.reportDeliveryRecipient.count({ where: { deliveryId: { in: [sent.id, failed.id] } } }), 2);
    });
  });

  it("history shows the number MASKED and the name", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, w.config);
      const run = await w.svc.sendTest(a);
      assert.equal(maskPhone(A), "+91••••••••10");
      assert.deepEqual(run.recipients.map((r) => [r.name, r.phone]), [["Ops", "+91••••••••33"], ["Owner", "+91••••••••10"]]);
      assert.ok(!JSON.stringify(run).includes("98765"), "the full number is not in the history response");
    });
  });
});

describe("test send", () => {
  it("needs a saved recipient and template; is its own TEST run; reports each recipient separately (one refused, one accepted, one with no answer); never blocks or counts as the scheduled report", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, T_1815);
      const a = w.as(w.admin, Role.ADMIN);
      await assert.rejects(() => w.svc.sendTest(a), /at least one recipient/);
      await w.svc.saveConfig(a, { ...w.config, recipients: [{ name: "Owner", phone: A }, { name: "Ops", phone: B }, { name: "Intl", phone: C }] });
      w.wa.state.modes[B] = "refuse";
      w.wa.state.modes[C] = "timeout";
      const run = await w.svc.sendTest(a);
      const r = Object.fromEntries(run.recipients.map((x) => [x.name!, x]));
      assert.deepEqual([r.Owner!.status, r.Ops!.status, r.Intl!.status], ["SENT", "FAILED", "UNCERTAIN"]);
      assert.match(r.Ops!.error ?? "", /not approved/);
      assert.match(r.Intl!.error ?? "", /may have been delivered/);
      assert.equal(run.kind, "TEST");
      assert.equal(run.status, "FAILED", "the run summary shows the worst outcome; the per-recipient rows carry the detail");
      assert.equal(await tx.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 0);
      // a scheduled run for the same day is still due and still sends once per recipient
      w.wa.state.modes = {};
      assert.deepEqual(await w.svc.runDue(), { checked: 1, started: 1 });
      assert.equal((await tx.reportDelivery.count({ where: { kind: "SCHEDULED" } })), 1);
    });
  });

  it("a test to chosen recipients only reaches those", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      const cfg = await w.svc.saveConfig(a, w.config);
      const run = await w.svc.sendTest(a, [cfg.recipients[1]!.id]);
      assert.deepEqual(run.recipients.map((x) => x.name), ["Ops"]);
      assert.deepEqual(w.wa.state.calls, [B]);
    });
  });
});

describe("scheduled delivery (18:15 Asia/Kolkata)", () => {
  it("is not sent before 18:15 IST (12:44 UTC) and is sent to EVERY recipient at 18:15 IST (12:45 UTC), recorded per recipient with the provider message id", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, T_1814);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), w.config);
      assert.deepEqual(await w.svc.runDue(), { checked: 1, started: 0 });
      assert.equal(w.wa.state.sent.length, 0);
      w.clock.now = at(T_1815);
      assert.equal((await w.svc.runDue()).started, 1);
      const run = await runOf(tx);
      assert.deepEqual([run.kind, run.reportDate, run.status, run.dedupeKey?.endsWith(":2026-10-23:18:15:2026-10-23")], ["SCHEDULED", "2026-10-23", "FAILED", true]);
      const r = byPhone(run);
      assert.deepEqual([r[A]!.status, r[A]!.attempts, r[B]!.status, r[B]!.attempts], ["SENT", 1, "SENT", 1]);
      assert.match(r[A]!.providerMessageId!, /^wamid\./);
      assert.match(w.wa.state.sent[0]!.text, /^Team report for 23 Oct 2026 \(Asia\/Kolkata\): Orders 2, /);
      assert.match(w.wa.state.sent[0]!.text, /24-hour window for this number is closed/, "the template is how a closed-window recipient is reached, and it says so");
      assert.deepEqual(run.recipientResults.map((x) => [x.txtStatus, x.docStatus]), [["FAILED", "SKIPPED"], ["FAILED", "SKIPPED"]], "the free-form parts were not attempted (window closed) and are shown as failed, not as success");
      assert.equal(w.wa.details.calls.length, 0);
      assert.deepEqual(w.wa.state.sent.map((s) => s.recipient).sort(), [B, A].sort());
      assert.ok(r[A]!.deliveredAt === null && r[A]!.readAt === null, "acceptance is NOT delivery");
    });
  });

  it("DUPLICATE PREVENTION: repeated and concurrent ticks, a 'restart', and a SECOND INSTANCE ticking at the same time send each recipient exactly once", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, T_1815);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), w.config);
      const second = w.mk(); // another application instance on the same database
      await Promise.all([w.svc.runDue(), w.svc.runDue(), second.runDue(), second.runDue("cron")]);
      await w.svc.runDue();
      await w.mk().runDue(); // restart
      w.clock.now = at("2026-10-23T17:30:00Z"); // later the same IST day
      await second.runDue();
      assert.equal(w.wa.state.sent.length, 2, "one message per recipient");
      assert.equal(await tx.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 1);
      assert.equal(await tx.reportDeliveryRecipient.count(), 2);
    });
  });

  it("MIXED RESULTS: one refused recipient does not stop the others; only the failed one is retried (5 then 15 minutes, 3 attempts); the others are never sent again", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, T_1815);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), { ...w.config, recipients: [{ name: "Owner", phone: A }, { name: "Ops", phone: B }, { name: "Intl", phone: C }] });
      w.wa.state.modes[B] = "refuse";
      await w.svc.runDue();
      let run = await runOf(tx);
      let r = byPhone(run);
      assert.deepEqual([r[A]!.status, r[B]!.status, r[C]!.status, run.status], ["SENT", "FAILED", "SENT", "FAILED"]);
      assert.equal(r[B]!.nextAttemptAt?.toISOString(), "2026-10-23T12:50:00.000Z");
      w.clock.now = at("2026-10-23T12:49:00Z");
      await w.svc.runDue();
      assert.equal(w.wa.state.calls.length, 3, "too early: nobody is contacted");
      w.clock.now = at("2026-10-23T12:50:00Z");
      await w.svc.runDue(); // attempt 2 - only Ops
      assert.deepEqual(w.wa.state.calls.slice(3), [B]);
      r = byPhone(await runOf(tx));
      assert.deepEqual([r[B]!.status, r[B]!.attempts, r[B]!.nextAttemptAt?.toISOString()], ["FAILED", 2, "2026-10-23T13:05:00.000Z"]);
      w.wa.state.modes = {}; // the cause is fixed
      w.clock.now = at("2026-10-23T13:05:00Z");
      await w.svc.runDue(); // attempt 3 succeeds
      run = await runOf(tx);
      r = byPhone(run);
      assert.deepEqual([r[B]!.status, r[B]!.attempts, r[A]!.attempts, r[C]!.attempts, run.status], ["SENT", 3, 1, 1, "FAILED"], "the run stays FAILED: the free-form parts could not go (window closed)");
      assert.equal(w.wa.state.calls.length, 5, "3 first sends + 2 retries of the one failed recipient");
    });
    await inRollback(async (tx) => {
      const w = await world(tx, T_1815);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), w.config);
      w.wa.state.modes[A] = "refuse";
      for (let i = 0; i < 6; i++) { await w.svc.runDue(); w.clock.now = new Date(w.clock.now.getTime() + 20 * 60_000); }
      const d = byPhone(await runOf(tx))[A]!;
      assert.deepEqual([d.status, d.attempts, d.nextAttemptAt], ["FAILED", MAX_ATTEMPTS, null]);
    });
  });

  it("NO ANSWER from the provider is UNCERTAIN for that recipient only, and is never re-sent automatically", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, T_1815);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), w.config);
      w.wa.state.modes[A] = "timeout";
      await w.svc.runDue();
      w.wa.state.modes = {};
      w.clock.now = at("2026-10-23T14:30:00Z");
      await w.svc.runDue();
      const run = await runOf(tx);
      const r = byPhone(run);
      assert.deepEqual([r[A]!.status, r[A]!.attempts, r[A]!.nextAttemptAt, r[B]!.status, run.status], ["UNCERTAIN", 1, null, "SENT", "FAILED"]);
      assert.match(r[A]!.error ?? "", /may have been delivered/);
      assert.equal(w.wa.state.calls.filter((p) => p === A).length, 1);
    });
  });

  it("RESTART mid-send: a recipient left SENDING by a crash is closed as UNCERTAIN after the stale window and is not sent again; the others still go out", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, T_1815);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), w.config);
      const auto = await tx.reportAutomation.findUniqueOrThrow({ where: { ownerId: w.admin.id } });
      const run = await tx.reportDelivery.create({ data: { automationId: auto.id, kind: "SCHEDULED", reportDate: "2026-10-23", dedupeKey: `${auto.id}:2026-10-23:18:15:2026-10-23`, recipient: A, status: "SENDING", attempts: 1 } });
      await tx.reportDeliveryRecipient.createMany({ data: [{ deliveryId: run.id, phone: A, name: "Owner", status: "SENDING", attempts: 1 }, { deliveryId: run.id, phone: B, name: "Ops", status: "PENDING" }] });
      await tx.$executeRaw`UPDATE report_delivery_recipients SET updated_at = ${new Date(w.clock.now.getTime() - 60_000)}`;
      await w.svc.runDue();
      let r = byPhone(await runOf(tx));
      assert.deepEqual([r[A]!.status, r[B]!.status], ["SENDING", "SENT"], "a fresh SENDING row may be a live worker: left alone; the pending one is sent");
      await tx.$executeRaw`UPDATE report_delivery_recipients SET updated_at = ${new Date(w.clock.now.getTime() - STALE_SENDING_MS - 60_000)} WHERE phone = ${A}`;
      await w.svc.runDue();
      r = byPhone(await runOf(tx));
      assert.equal(r[A]!.status, "UNCERTAIN");
      assert.deepEqual(w.wa.state.calls, [B]);
    });
  });

  it("the recipient list is copied when the day's run is created: someone added later joins the NEXT day's run, someone removed does not erase today's history", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, T_1815);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, w.config);
      await w.svc.runDue();
      await w.svc.saveConfig(a, { ...w.config, recipients: [{ name: "Intl", phone: C }] }); // A and B removed, C added
      w.clock.now = at("2026-10-23T15:00:00Z");
      await w.svc.runDue();
      assert.deepEqual((await runOf(tx)).recipientResults.map((x) => x.phone).sort(), [A, B].sort(), "today's history is intact");
      w.clock.now = at("2026-10-24T12:45:00Z");
      await w.svc.runDue();
      assert.deepEqual(w.wa.state.calls.slice(2), [C], "tomorrow goes to the new list only");
    });
  });

  it("missing or invalid setup never sends: a disabled automation is ignored; no recipients makes no run; a missing template fails with a clear reason per recipient; a demoted owner is refused", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, { ...w.config, enabled: false });
      assert.deepEqual(await w.svc.runDue(), { checked: 0, started: 0 });
      await tx.reportAutomation.update({ where: { ownerId: w.admin.id }, data: { enabled: true, updatedAt: w.clock.now } });
      await tx.reportRecipient.deleteMany({});
      assert.deepEqual(await w.svc.runDue(), { checked: 1, started: 0 });
      assert.equal(await tx.reportDelivery.count(), 0);
      await w.svc.saveConfig(a, w.config);
      await tx.reportAutomation.update({ where: { ownerId: w.admin.id }, data: { templateName: null, updatedAt: w.clock.now } });
      await w.svc.runDue();
      const run = await runOf(tx);
      assert.deepEqual(run.recipientResults.map((x) => [x.status, /No WhatsApp template/.test(x.error ?? "")]), [["FAILED", true], ["FAILED", true]]);
      assert.equal(w.wa.state.calls.length, 0);
    });
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.svc.saveConfig(w.as(w.manager, Role.MANAGER), w.config);
      await tx.user.update({ where: { id: w.manager.id }, data: { role: Role.SALESPERSON } });
      await w.svc.runDue();
      const run = await runOf(tx);
      assert.ok(run.recipientResults.every((x) => x.status === "FAILED" && /no longer an active Admin or Manager/.test(x.error ?? "")));
      assert.equal(w.wa.state.calls.length, 0);
    });
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), w.config);
      await tx.user.update({ where: { id: w.admin.id }, data: { status: UserStatus.INACTIVE } });
      await w.svc.runDue();
      assert.equal(w.wa.state.calls.length, 0);
    });
  });
});

describe("scheduler heartbeat (why 'nothing was sent' is visible)", () => {
  it("every tick - timer or external cron - records when it ran; the status says whether the scheduler is alive, who triggered it, and which approved one-variable templates exist", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, T_1814);
      const a = w.as(w.admin, Role.ADMIN);
      await tx.reportSchedulerState.deleteMany({});
      let s = await w.svc.status(a);
      assert.deepEqual([s.scheduler.running, s.scheduler.lastTickAt, s.scheduler.secondsSinceLastTick], [false, null, null], "never ticked: the page can say so");
      await w.svc.runDue("scheduler");
      s = await w.svc.status(a);
      assert.deepEqual([s.scheduler.running, s.scheduler.lastSource, s.scheduler.secondsSinceLastTick], [true, "scheduler", 0]);
      w.clock.now = new Date(w.clock.now.getTime() + SCHEDULER_STALE_MS + 1000);
      assert.equal((await w.svc.status(a)).scheduler.running, false, "a host that went to sleep shows as not running");
      await w.svc.runDue("cron");
      assert.deepEqual([(await w.svc.status(a)).scheduler.running, (await w.svc.status(a)).scheduler.lastSource], [true, "cron"]);
      const mk = (name: string, vars: string[]) => tx.whatsAppTemplate.create({ data: { name, provider: "META", language: "en", body: "x", variables: vars as never, status: "APPROVED" } });
      await mk("daily_team_report", ["report_text"]);
      await mk("rt_two_vars", ["a", "b"]);
      await mk("webinar_feedback_form", ["customer_name"]);
      await mk("rt_no_vars", []);
      const names = (await w.svc.status(a)).whatsapp.templates.map((t) => t.name);
      assert.deepEqual(names, ["daily_team_report"], "only the dedicated one-variable report template is offered");
    });
  });
});

describe("provider delivery callbacks (acceptance is not delivery)", () => {
  const sentRow = async (tx: Prisma.TransactionClient, providerMessageId = "wamid.X1", provider = "META") => {
    const w = await world(tx);
    await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), { ...w.config, recipients: [{ name: "Owner", phone: A }] });
    const auto = await tx.reportAutomation.findUniqueOrThrow({ where: { ownerId: w.admin.id } });
    const run = await tx.reportDelivery.create({ data: { automationId: auto.id, kind: "SCHEDULED", reportDate: "2026-10-23", dedupeKey: `${auto.id}:2026-10-23:18:15:2026-10-23`, recipient: A, status: "SENT", attempts: 1 } });
    const row = await tx.reportDeliveryRecipient.create({ data: { deliveryId: run.id, phone: A, name: "Owner", status: "SENT", attempts: 1, provider, providerMessageId, sentAt: at(T_1815) } });
    return { w, run, row };
  };
  const ev = (status: "SENT" | "DELIVERED" | "READ" | "FAILED", iso: string, extra: object = {}) => ({ providerMessageId: "wamid.X1", status, timestamp: at(iso), ...extra });

  it("DELIVERED and READ arrive only from the callback, move forward only, and are idempotent (duplicates and out-of-order events change nothing)", async () => {
    await inRollback(async (tx) => {
      const { row, run } = await sentRow(tx);
      const get = () => tx.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: row.id } });
      assert.deepEqual([(await get()).status, (await get()).deliveredAt], ["SENT", null]);
      assert.equal(await applyReportDeliveryStatus(tx, "META", ev("DELIVERED", "2026-10-23T12:46:00Z")), 1);
      assert.deepEqual([(await get()).status, (await get()).deliveredAt?.toISOString()], ["DELIVERED", "2026-10-23T12:46:00.000Z"]);
      assert.equal(await applyReportDeliveryStatus(tx, "META", ev("DELIVERED", "2026-10-23T12:46:30Z")), 0, "a duplicate changes nothing");
      assert.equal(await applyReportDeliveryStatus(tx, "META", ev("READ", "2026-10-23T12:50:00Z")), 1);
      assert.equal((await get()).status, "READ");
      assert.equal(await applyReportDeliveryStatus(tx, "META", ev("DELIVERED", "2026-10-23T12:47:00Z")), 0, "a late DELIVERED never moves READ backwards");
      assert.equal(await applyReportDeliveryStatus(tx, "META", ev("SENT", "2026-10-23T12:45:00Z")), 0);
      assert.deepEqual([(await get()).status, (await get()).readAt?.toISOString()], ["READ", "2026-10-23T12:50:00.000Z"]);
      assert.equal((await tx.reportDelivery.findUniqueOrThrow({ where: { id: run.id } })).status, "SENT", "the run summary stays 'accepted or better'");
    });
  });

  it("READ before DELIVERED (out of order) still ends READ and fills the delivered time; a failure callback marks FAILED with the provider's reason but never overrides DELIVERED / READ", async () => {
    await inRollback(async (tx) => {
      const { row, run } = await sentRow(tx);
      await applyReportDeliveryStatus(tx, "META", ev("READ", "2026-10-23T12:50:00Z"));
      let r = await tx.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: row.id } });
      assert.deepEqual([r.status, r.deliveredAt !== null], ["READ", true]);
      assert.equal(await applyReportDeliveryStatus(tx, "META", ev("FAILED", "2026-10-23T12:55:00Z", { errorMessage: "late failure" })), 0);

      const other = await sentRow(tx, "wamid.X2");
      await applyReportDeliveryStatus(tx, "META", { providerMessageId: "wamid.X2", status: "FAILED", timestamp: at("2026-10-23T12:46:00Z"), errorMessage: "Recipient not on WhatsApp" });
      r = await tx.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: other.row.id } });
      assert.deepEqual([r.status, r.error], ["FAILED", "Recipient not on WhatsApp"]);
      assert.equal((await tx.reportDelivery.findUniqueOrThrow({ where: { id: other.run.id } })).status, "FAILED");
      void run;
    });
  });

  it("an unknown message id, another provider's id, and a customer message id change nothing", async () => {
    await inRollback(async (tx) => {
      const { row } = await sentRow(tx);
      assert.equal(await applyReportDeliveryStatus(tx, "META", { providerMessageId: "wamid.NOPE", status: "DELIVERED", timestamp: new Date() }), 0);
      assert.equal(await applyReportDeliveryStatus(tx, "AISENSY", ev("DELIVERED", "2026-10-23T12:46:00Z")), 0, "the id belongs to Meta, not AiSensy");
      assert.equal((await tx.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: row.id } })).status, "SENT");
    });
  });

  it("the CRM's shared WhatsApp status path (used by the signature-verified Meta and AiSensy webhooks) applies it to the report recipient", async () => {
    await inRollback(async (tx) => {
      const { row } = await sentRow(tx);
      await new WhatsAppService(tx).recordStatusUpdate("META", { providerMessageId: "wamid.X1", status: "DELIVERED", timestamp: at("2026-10-23T12:46:00Z") });
      assert.equal((await tx.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: row.id } })).status, "DELIVERED");
      await new WhatsAppService(tx).recordStatusUpdate("META", { providerMessageId: "wamid.X1", status: "DELIVERED", timestamp: at("2026-10-23T12:46:00Z") }); // redelivered webhook
      assert.equal((await tx.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: row.id } })).status, "DELIVERED");
    });
  });
});

describe("authorized retry of a definitely failed delivery", () => {
  it("retries only the failed recipient, only for its owner; an accepted or unknown-outcome message is refused; concurrent retries send once", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, T_1815);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, w.config);
      w.wa.state.modes[A] = "refuse";
      w.wa.state.modes[B] = "timeout";
      const run = await w.svc.sendTest(a);
      const failed = run.recipients.find((r) => r.status === "FAILED")!;
      const unknown = run.recipients.find((r) => r.status === "UNCERTAIN")!;
      assert.deepEqual([failed.canRetry, unknown.canRetry], [true, false]);
      await assert.rejects(() => w.svc.retryRecipient(a, unknown.id), /never sent again automatically/);
      await assert.rejects(() => w.svc.retryRecipient(w.as(w.manager, Role.MANAGER), failed.id), /Delivery not found/);
      w.wa.state.modes = {};
      const before = w.wa.state.calls.length;
      const results = await Promise.allSettled([w.svc.retryRecipient(a, failed.id), w.svc.retryRecipient(a, failed.id)]);
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1, "only one retry wins the claim");
      assert.equal(w.wa.state.calls.length - before, 1);
      const after1 = (await w.svc.history(a, 1, 20)).items[0]!.recipients.find((r) => r.id === failed.id)!;
      assert.deepEqual([after1.status, after1.attempts, after1.canRetry], ["SENT", 2, false]);
      await assert.rejects(() => w.svc.retryRecipient(a, failed.id), /definitely failed/);
    });
  });
});

describe("the real WhatsApp sender (no provider is configured in the test environment, so nothing can be sent)", () => {
  const input = { recipient: A, templateName: "daily_team_report", languageCode: "en", text: "x" };
  it("refuses with a clear reason when the template does not exist, is not approved, has the wrong number of variables, or no provider is configured", async () => {
    await inRollback(async (tx) => {
      const send = createWhatsAppReportSender(tx);
      await assert.rejects(() => send(input), (e: unknown) => e instanceof ReportSendRejected && /No APPROVED WhatsApp template named "daily_team_report"/.test((e as Error).message));
      const tpl = (status: "DRAFT" | "APPROVED", variables: unknown, name = "daily_team_report") => tx.whatsAppTemplate.create({ data: { name, provider: "META", language: "en", body: "Report {{report}}", variables: variables as never, status } });
      await tpl("DRAFT", ["report_text"]);
      await assert.rejects(() => send(input), /No APPROVED WhatsApp template/);
      await tx.whatsAppTemplate.deleteMany({ where: { name: "daily_team_report" } });
      await tpl("APPROVED", ["a", "b"]);
      await assert.rejects(() => send(input), /exactly ONE variable.*has 2/);
      await tx.whatsAppTemplate.deleteMany({ where: { name: "daily_team_report" } });
      await tpl("APPROVED", ["report_text"]);
      await assert.rejects(() => send(input), (e: unknown) => e instanceof ReportSendRejected && /not configured/.test((e as Error).message));
      // language: saved "en" but the template is approved as "en_GB" -> that single approved language is used (the case that blocked a real test send); several languages and no match is refused
      await tx.whatsAppTemplate.deleteMany({ where: { name: "daily_team_report" } });
      await tx.whatsAppTemplate.create({ data: { name: "daily_team_report", provider: "META", language: "en_GB", body: "Report {{report}}", variables: ["report_text"] as never, status: "APPROVED" } });
      await assert.rejects(() => send(input), (e: unknown) => e instanceof ReportSendRejected && /not configured/.test((e as Error).message), "resolved the template, then stopped only at the missing provider");
      await tx.whatsAppTemplate.create({ data: { name: "daily_team_report", provider: "META", language: "hi", body: "Report {{report}}", variables: ["report_text"] as never, status: "APPROVED" } });
      await assert.rejects(() => send(input), /approved in several languages \(en_GB, hi\)|approved in several languages \(hi, en_GB\)/);
    });
  });
});

describe("Excel attachment (the second message)", () => {
  const withExcel = (w: Awaited<ReturnType<typeof world>>) => { w.wa.details.closed.clear(); return { ...w.config, sendExcel: true }; };

  it("text and the .xlsx go to every recipient as two separate messages, each tracked on its own; the file is uploaded once and named by the report date", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), withExcel(w));
      await w.svc.runDue();
      const run = await runOf(tx);
      assert.deepEqual(run.recipientResults.map((r) => [r.status, r.txtStatus, r.docStatus]), [["SKIPPED", "SENT", "SENT"], ["SKIPPED", "SENT", "SENT"]], "window open: no template needed");
      assert.equal(run.status, "SENT");
      assert.ok(run.recipientResults.every((r) => r.txtProviderMessageId && r.docProviderMessageId && r.txtProviderMessageId !== r.docProviderMessageId));
      assert.deepEqual(w.wa.docs.files.map((f) => f.filename), ["AyushWellness_Daily_Report_2026-10-23.xlsx", "AyushWellness_Daily_Report_2026-10-23.xlsx"]);
      assert.equal(w.wa.docs.uploads, 1, "uploaded once, reused");
      assert.ok(w.wa.docs.files.every((f) => f.size > 1000));
      // running again changes nothing
      await w.svc.runDue();
      await w.mk().runDue();
      assert.equal(w.wa.docs.calls.length, 2);
      assert.equal(w.wa.state.calls.length, 0, "no template message at all while the window is open");
    });
  });

  it("PARTIAL FAILURE: text accepted but Excel refused is shown as exactly that; retrying the Excel does NOT re-send the text, and the text row is untouched", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, withExcel(w));
      w.wa.docs.modes[A] = "refuse";
      await w.svc.runDue();
      let run = await runOf(tx);
      const r = run.recipientResults.find((x) => x.phone === A)!;
      assert.deepEqual([r.status, r.docStatus, run.status], ["SENT", "FAILED", "FAILED"]);
      assert.match(r.docError ?? "", /24 hours/);
      assert.equal(run.recipientResults.find((x) => x.phone === B)!.docStatus, "SENT", "the other recipient is unaffected");
      await w.svc.runDue(); // not auto-retried
      assert.equal(w.wa.docs.calls.filter((p) => p === A).length, 1);
      const textCalls = w.wa.state.calls.length;
      const hist = (await w.svc.history(a, 1, 10)).items[0]!.recipients.find((x) => x.name === "Owner")!;
      assert.deepEqual([hist.document.canRetry, hist.canRetry], [true, false]);
      w.wa.docs.modes = {};
      const res = await w.svc.retryRecipient(a, hist.id, "DOCUMENT");
      assert.deepEqual([res.status, res.document.status, res.document.attempts], ["SENT", "SENT", 2]);
      assert.equal(w.wa.state.calls.length, textCalls, "the text was not sent again");
      run = await runOf(tx);
      assert.equal(run.status, "SENT");
      await assert.rejects(() => w.svc.retryRecipient(a, hist.id, "DOCUMENT"), /definitely failed/);
    });
  });

  it("the messages are independent per recipient: a refused template for the closed-window recipient does not stop the open-window recipient's detailed text and Excel; retrying the template sends only the template", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), withExcel(w));
      w.wa.details.closed.add(A); // A: window closed -> template; B: open -> detailed text + Excel directly
      w.wa.state.modes[A] = "refuse";
      await w.svc.runDue();
      let ra = (await runOf(tx)).recipientResults.find((x) => x.phone === A)!;
      const rb = (await runOf(tx)).recipientResults.find((x) => x.phone === B)!;
      assert.deepEqual([ra.status, ra.txtStatus, ra.docStatus], ["FAILED", "FAILED", "FAILED"]);
      assert.deepEqual([rb.status, rb.txtStatus, rb.docStatus], ["SKIPPED", "SENT", "SENT"]);
      w.wa.state.modes = {};
      w.clock.now = at("2026-10-23T12:50:00Z");
      await w.svc.runDue();
      ra = (await runOf(tx)).recipientResults.find((x) => x.phone === A)!;
      assert.deepEqual([ra.status, ra.attempts], ["SENT", 2]);
      assert.equal(w.wa.state.calls.filter((p) => p === B).length, 0, "B never needed the template");
      assert.equal(w.wa.details.calls.filter((p) => p === B).length, 1, "B's detailed text was not sent again");
    });
  });

  it("FALLBACK: the window was believed open, WhatsApp refuses the free-form message anyway -> only then is the template sent, so the recipient is still reached", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, withExcel(w));
      w.wa.details.modes[A] = "refuse"; // fake text refusal message is "Meta refused the text" - make it the real window error
      const original = w.wa.sendDetail;
      void original;
      await w.svc.saveConfig(a, withExcel(w));
      const svc2 = new ReportAutomationService(tx, { now: () => w.clock.now, sources, send: w.wa.send, sendDocument: w.wa.sendDocument, windowOpen: w.wa.windowOpen, sendDetail: async (input) => { if (input.recipient === A) throw new ReportSendRejected("WhatsApp only delivers a file inside 24 hours of the recipient's last message"); return w.wa.sendDetail(input); } });
      w.wa.details.modes = {};
      w.wa.docs.modes[A] = "refuse";
      await svc2.runDue();
      const ra = (await runOf(tx)).recipientResults.find((x) => x.phone === A)!;
      const rb = (await runOf(tx)).recipientResults.find((x) => x.phone === B)!;
      assert.deepEqual([ra.status, ra.txtStatus, ra.docStatus], ["SENT", "FAILED", "FAILED"], "template sent as the fallback");
      assert.match(w.wa.state.sent.find((s) => s.recipient === A)!.text, /24-hour window for this number is closed/);
      assert.deepEqual([rb.status, rb.txtStatus, rb.docStatus], ["SKIPPED", "SENT", "SENT"]);
      assert.equal(w.wa.state.calls.filter((p) => p === B).length, 0);
    });
  });

  it("no answer for the Excel is UNCERTAIN and never re-sent automatically; the text stays SENT", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), withExcel(w));
      w.wa.docs.modes[B] = "timeout";
      await w.svc.runDue();
      w.wa.docs.modes = {};
      w.clock.now = at("2026-10-23T15:00:00Z");
      await w.svc.runDue();
      const r = byPhone2(await runOf(tx))[B]!;
      assert.deepEqual([r.status, r.docStatus, w.wa.docs.calls.filter((p) => p === B).length], ["SKIPPED", "UNCERTAIN", 1]);
      assert.match((await tx.reportDeliveryRecipient.findFirstOrThrow({ where: { phone: B } })).docError ?? "", /may have been delivered/);
    });
  });

  it("text-only and Excel-only automations mark the other part SKIPPED (not 'success'); both off cannot be enabled", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      w.wa.details.closed.clear();
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), { ...w.config, sendText: false, sendExcel: true });
      await w.svc.runDue();
      const r = byPhone2(await runOf(tx))[A]!;
      assert.deepEqual([r.status, r.docStatus, w.wa.state.calls.length, w.wa.docs.calls.length, (await runOf(tx)).recipientResults[0]!.txtStatus], ["SKIPPED", "SENT", 0, 2, "SKIPPED"]);
      assert.equal((await runOf(tx)).status, "SENT");
    });
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), w.config);
      await w.svc.runDue();
      const r = byPhone2(await runOf(tx))[A]!;
      assert.deepEqual([r.status, r.docStatus, w.wa.docs.calls.length, w.wa.details.calls.length], ["SENT", "SKIPPED", 0, 0], "text only, window closed: the template is the only message that can go");
    });
    assert.ok(validateConfigInput({ enabled: true, recipients: [{ phone: A }], sendTime: "18:15", timezone: IST, reportFor: "TODAY", templateName: "daily_team_report", languageCode: "en_GB", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, sendText: false, sendExcel: false }).error);
  });

  it("test send sends text and Excel as a TEST run, separate from the scheduled report", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, withExcel(w));
      const run = await w.svc.sendTest(a);
      assert.deepEqual([run.kind, run.recipients.map((r) => [r.status, r.document.status])], ["TEST", [["SKIPPED", "SENT"], ["SKIPPED", "SENT"]]]);
      assert.equal(await tx.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 0);
    });
  });

  it("DOCUMENT delivery callbacks: Delivered / Read update only the document row, by the document's own message id", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), { ...withExcel(w), recipients: [{ name: "Owner", phone: A }] });
      await w.svc.runDue();
      const r0 = (await runOf(tx)).recipientResults[0]!;
      assert.equal(await applyReportDeliveryStatus(tx, "META", { providerMessageId: r0.docProviderMessageId!, status: "DELIVERED", timestamp: at("2026-10-23T12:46:00Z") }), 1);
      const r1 = await tx.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: r0.id } });
      assert.deepEqual([r1.status, r1.docStatus, r1.docDeliveredAt?.toISOString()], ["SKIPPED", "DELIVERED", "2026-10-23T12:46:00.000Z"]);
      assert.equal(await applyReportDeliveryStatus(tx, "AISENSY", { providerMessageId: r0.docProviderMessageId!, status: "READ", timestamp: new Date() }), 0, "documents are Meta-only");
    });
  });

  it("the real document sender refuses with the exact limitation when Meta is not configured (e.g. the template goes through AiSensy)", async () => {
    await inRollback(async (tx) => {
      const send = createWhatsAppReportDocumentSender(tx, async () => "AISENSY");
      await assert.rejects(() => send({ recipient: A, filename: "x.xlsx", bytes: Buffer.from("x"), caption: "c" }), (e: unknown) => e instanceof ReportSendRejected && /only be sent through the Meta WhatsApp Cloud API.*AISENSY/.test((e as Error).message));
      assert.match(explainDocumentError("Meta rejected (HTTP 400): Message failed to send because more than 24 hours have passed - code 131047"), /ask them to send any message/);
    });
  });
});

describe("the dedicated template", () => {
  it("only daily_team_report is accepted (never webinar_feedback_form or CRM Outbound Test); its language is resolved from the synced template; a wrong variable or an unapproved template stops the send", async () => {
    await inRollback(async (tx) => {
      const make = (name: string, language: string, variables: string[], status: "APPROVED" | "PENDING") => tx.whatsAppTemplate.create({ data: { name, provider: "META", language, body: "x {{" + (variables[0] ?? "v") + "}}", variables: variables as never, status } });
      await make("daily_team_report", "en_GB", ["report_text"], "APPROVED");
      await make("webinar_feedback_form", "en_GB", ["customer_name"], "APPROVED");
      const send = createWhatsAppReportSender(tx);
      await assert.rejects(() => send({ recipient: A, templateName: "webinar_feedback_form", languageCode: "en_GB", text: "x" }), /dedicated template "daily_team_report"/);
      await assert.rejects(() => send({ recipient: A, templateName: "CRM Outbound Test", languageCode: "en", text: "x" }), /dedicated template/);
      // the saved language "en" resolves to the single approved language (en_GB); the send stops only at the missing provider in this test database
      await assert.rejects(() => send({ recipient: A, templateName: "daily_team_report", languageCode: "en", text: "x" }), /not configured/);
      await tx.whatsAppTemplate.deleteMany({ where: { name: "daily_team_report" } });
      await make("daily_team_report", "en_GB", ["customer_name"], "APPROVED");
      await assert.rejects(() => send({ recipient: A, templateName: "daily_team_report", languageCode: "en_GB", text: "x" }), /needs \{\{report_text\}\}/);
      await tx.whatsAppTemplate.deleteMany({ where: { name: "daily_team_report" } });
      await make("daily_team_report", "en_GB", ["report_text"], "PENDING");
      await assert.rejects(() => send({ recipient: A, templateName: "daily_team_report", languageCode: "en_GB", text: "x" }), /No APPROVED WhatsApp template/);
    });
  });

  it("THE OUTBOUND SEQUENCE: window open -> detailed text then Excel and NO short summary / template message at all; window closed -> only the template notification (its one job); never a webinar or unrelated text", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      w.wa.details.closed.clear(); // both recipients inside the window
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), { ...w.config, sendExcel: true });
      await w.svc.runDue();
      assert.equal(w.wa.state.sent.length, 0, "no short template/summary message while the free-form report can be delivered");
      assert.equal(w.wa.details.texts.length, 2);
      assert.equal(w.wa.docs.files.length, 2);
      const text = w.wa.details.texts[0]!.text;
      assert.match(text, /^\*AYUSHWELLNESS \| DAILY TEAM REPORT\*\n/);
      assert.ok(!/webinar|feedback|attended|follow in the next messages|Team report for/i.test(text), "the detailed report does not contain the short summary line");
      assert.equal(text.split("TEAM OVERVIEW").length - 1, 1, "the report appears once");
      assert.ok(!(await tx.reportDeliveryRecipient.findMany()).some((r) => r.status === "SENT"), "history: the template part is 'Not needed', never shown as sent");
    });
    await inRollback(async (tx) => {
      const w = await world(tx); // windows closed
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), { ...w.config, sendExcel: true });
      await w.svc.runDue();
      assert.equal(w.wa.state.sent.length, 2);
      assert.ok(w.wa.state.sent.every((s) => s.templateName === "daily_team_report" && !/webinar|feedback|attended/i.test(s.text) && !/[\n\t]/.test(s.text) && /24-hour window for this number is closed/.test(s.text)));
      assert.equal(w.wa.details.calls.length + w.wa.docs.calls.length, 0, "no free-form attempt outside the window");
    });
  });
});

describe("next scheduled run and why nothing is scheduled", () => {
  it("says when the next report goes out in the saved timezone, and gives the exact reason when none is scheduled", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, "2026-10-23T04:00:00Z"); // 09:30 IST
      const a = w.as(w.admin, Role.ADMIN);
      assert.match((await w.svc.status(a)).nextRun.reason ?? "", /not been set up/);
      await w.svc.saveConfig(a, { ...w.config, enabled: false });
      assert.match((await w.svc.status(a)).nextRun.reason ?? "", /turned OFF/);
      await w.svc.saveConfig(a, w.config);
      let n = (await w.svc.status(a)).nextRun;
      assert.deepEqual([n.at?.toISOString(), n.dueNow, n.reason], ["2026-10-23T12:45:00.000Z", false, null], "18:15 IST today");
      w.clock.now = at("2026-10-23T12:50:00Z");
      n = (await w.svc.status(a)).nextRun;
      assert.equal(n.dueNow, true);
      await w.svc.runDue();
      n = (await w.svc.status(a)).nextRun;
      assert.deepEqual([n.at?.toISOString(), n.dueNow], ["2026-10-24T12:45:00.000Z", false], "tomorrow 18:15 IST");
      await w.svc.saveConfig(a, { ...w.config, recipients: [], enabled: false });
      await tx.reportAutomation.update({ where: { ownerId: w.admin.id }, data: { enabled: true, updatedAt: w.clock.now } });
      assert.match((await w.svc.status(a)).nextRun.reason ?? "", /No recipients/);
    });
  });

  it("YESTERDAY coverage reports the previous local day, sent at the configured time", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, T_1815);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), { ...w.config, reportFor: "YESTERDAY" });
      await w.svc.runDue();
      assert.equal((await runOf(tx)).reportDate, "2026-10-22");
      assert.match(w.wa.state.sent[0]!.text, /Team report for 22 Oct 2026/);
    });
  });
});

// a duration cell is a fraction of a day; ExcelJS hands a time-formatted cell back as a Date measured from the Excel epoch
const dayFraction = (v: unknown): number => (v instanceof Date ? (v.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000 : Number(v));

describe("the Excel file itself", () => {
  const data = {
    date: "2026-10-23", from: "2026-10-23", to: "2026-10-23", timezone: IST, offsetMinutes: 330,
    people: [
      { id: "1", name: "Asha", leads: 10, contacted: 8, interested: 4, converted: 2, conversionPct: 20, calls: 30, connected: 20, talkTimeSec: 3600, orders: 2, revenue: 1298.5, cancelledOrders: 1, pendingFollowUps: 3 },
      { id: "2", name: "=HYPERLINK(\"http://evil\")", leads: 0, contacted: 0, interested: 0, converted: 0, conversionPct: null, calls: 0, connected: 0, talkTimeSec: 0, orders: 0, revenue: 0, cancelledOrders: 0, pendingFollowUps: 0 },
    ],
    scope: [{ id: "1", name: "Asha" }, { id: "2", name: "x" }],
    team: { telecallers: 2, leads: 10, contacted: 8, interested: 4, converted: 2, conversionPct: 20, calls: 30, connected: 20, talkTimeSec: 3600, orders: 2, revenue: 1298.5, cancelledOrders: 1, pendingFollowUps: 3 },
  };
  const opts = { teamSummary: true, calls: true, leads: true, sales: true, followUps: true };

  it("is a real xlsx (zip) with the Team Summary and Telecaller Performance sheets, the report's numbers, number formats, frozen header and filter; no Order Details sheet", async () => {
    const buf = await buildReportXlsx(data, opts);
    assert.equal(buf.subarray(0, 2).toString(), "PK", "an OOXML zip, not renamed text");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    assert.deepEqual(wb.worksheets.map((s) => s.name), ["Team Summary", "Telecaller Performance"]);
    const sum = wb.getWorksheet("Team Summary")!;
    const rows = new Map<string, ExcelJS.Row>();
    sum.eachRow((row) => rows.set(String(row.getCell(1).value), row));
    const val = (label: string) => rows.get(label)!.getCell(2).value;
    assert.deepEqual([val("Report date"), val("Orders"), val("Revenue"), val("Cancelled orders"), val("Leads handled"), val("Calls"), val("Pending follow-ups")], ["2026-10-23", 2, 1298.5, 1, 10, 30, 3]);
    assert.equal(val("Conversion rate"), 0.2);
    assert.ok(Math.abs(dayFraction(val("Talk time")) - 3600 / 86400) < 1e-6, "1 hour as a fraction of a day");
    assert.match(String(val("Timezone")), /Asia\/Kolkata \(UTC\+05:30\)/);
    assert.equal(rows.get("Revenue")!.getCell(2).numFmt, '"₹"#,##0.00');
    assert.equal(rows.get("Conversion rate")!.getCell(2).numFmt, "0.0%");
    assert.equal(rows.get("Talk time")!.getCell(2).numFmt, "[h]:mm:ss");
    const perf = wb.getWorksheet("Telecaller Performance")!;
    assert.deepEqual((perf.getRow(1).values as unknown[]).slice(1), ["Telecaller", "Orders", "Revenue", "Cancelled orders", "Leads handled", "Converted leads", "Conversion rate", "Total calls", "Connected calls", "Talk time (h:mm:ss)", "Pending follow-ups"]);
    const asha = (perf.getRow(2).values as unknown[]).slice(1);
    assert.ok(Math.abs(dayFraction(asha[9]) - 3600 / 86400) < 1e-6);
    assert.deepEqual(asha.filter((_, i) => i !== 9), ["Asha", 2, 1298.5, 1, 10, 2, 0.2, 30, 20, 3]);
    assert.equal(perf.getRow(3).getCell(7).value, "n/a", "a zero denominator is shown as n/a, not 0% or an error");
    assert.deepEqual([perf.views[0]?.state, (perf.views[0] as { ySplit?: number }).ySplit, Boolean(perf.autoFilter)], ["frozen", 1, true]);
    assert.equal(perf.rowCount, 3);
  });

  it("formula-like names are stored as text, never as a formula", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildReportXlsx(data, opts)) as never);
    const cell = wb.getWorksheet("Telecaller Performance")!.getRow(3).getCell(1);
    assert.equal(typeof cell.value, "string");
    assert.ok(String(cell.value).startsWith("'="));
    assert.equal(safeCell("+1+1"), "'+1+1");
    assert.equal(safeCell("-2"), "'-2");
    assert.equal(safeCell("@SUM(A1)"), "'@SUM(A1)");
    assert.equal(safeCell("Ayush"), "Ayush");
  });

  it("only the selected content groups are included (same selections as the text)", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildReportXlsx(data, { teamSummary: true, calls: false, leads: false, sales: true, followUps: false })) as never);
    assert.deepEqual((wb.getWorksheet("Telecaller Performance")!.getRow(1).values as unknown[]).slice(1), ["Telecaller", "Orders", "Revenue", "Cancelled orders"]);
  });
});

describe("template selector regression: an approved Meta template registered as daily_team_report1 (language en, {{report_text}})", () => {
  const make = (tx: Prisma.TransactionClient, name: string, status: "APPROVED" | "PENDING" | "DRAFT", variables: string[], language = "en", provider: "META" | "AISENSY" = "META") =>
    tx.whatsAppTemplate.create({ data: { name, provider, language, body: "x", variables: variables as never, status } });

  it("appears in the selector with provider, language and status; unapproved or incompatible ones do not, and say exactly why; unrelated templates are never offered", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      await make(tx, "daily_team_report1", "APPROVED", ["report_text"]);
      await make(tx, "daily_team_report_draft", "DRAFT", ["report_text"]);
      await make(tx, "daily_team_report_pending", "PENDING", ["report_text"]);
      await make(tx, "daily_team_report_wrongvar", "APPROVED", ["customer_name"]);
      await make(tx, "daily_team_report_two", "APPROVED", ["a", "b"]);
      await make(tx, "webinar_feedback_form", "APPROVED", ["customer_name"], "en_GB");
      await make(tx, "CRM Outbound Test", "APPROVED", ["name"], "en", "AISENSY");
      const wa = (await w.svc.status(a)).whatsapp;
      assert.deepEqual(wa.templates, [{ name: "daily_team_report1", provider: "META", language: "en", status: "APPROVED" }]);
      const why = Object.fromEntries(wa.unusableTemplates.map((t) => [t.name, t.reason]));
      assert.match(why.daily_team_report_draft!, /Not approved.*DRAFT/);
      assert.match(why.daily_team_report_pending!, /Not approved.*PENDING/);
      assert.match(why.daily_team_report_wrongvar!, /customer_name.*report_text/);
      assert.match(why.daily_team_report_two!, /2 variables/);
      assert.ok(!("webinar_feedback_form" in why) && !wa.templates.some((t) => t.name === "webinar_feedback_form" || t.name === "CRM Outbound Test"), "unrelated templates are neither offered nor listed as candidates");
    });
  });

  it("selecting it and saving keeps its name and language across a reload; the validator accepts it and still refuses unrelated templates", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      const body = { ...w.config, templateName: "daily_team_report1", languageCode: "en" };
      assert.ifError(validateConfigInput(body).error);
      assert.ok(validateConfigInput({ ...body, templateName: "webinar_feedback_form" }).error);
      assert.ok(validateConfigInput({ ...body, templateName: "CRM Outbound Test" }).error);
      await w.svc.saveConfig(a, body);
      const cfg = await w.svc.getConfig(a);
      assert.deepEqual([cfg.templateName, cfg.languageCode], ["daily_team_report1", "en"]);
    });
  });

  it("the sender accepts it (name family, APPROVED, single {{report_text}}) and resolves the template as META; it stops only at the missing provider in the test database", async () => {
    await inRollback(async (tx) => {
      await make(tx, "daily_team_report1", "APPROVED", ["report_text"]);
      const send = createWhatsAppReportSender(tx);
      await assert.rejects(() => send({ recipient: A, templateName: "daily_team_report1", languageCode: "en", text: "x" }), (e: unknown) => e instanceof ReportSendRejected && /\(META\) is not configured/.test((e as Error).message));
      await assert.rejects(() => send({ recipient: A, templateName: "webinar_feedback_form", languageCode: "en", text: "x" }), /dedicated template/);
    });
  });
});

describe("notification + detailed text + Excel: three separate parts", () => {
  const all = (w: Awaited<ReturnType<typeof world>>) => { w.wa.details.closed.clear(); return { ...w.config, sendExcel: true }; };
  const parts = (r: { status: string; txtStatus: string; docStatus: string }) => [r.status, r.txtStatus, r.docStatus];

  it("happy path (window open): the readable multi-line text and the Excel go to each recipient, each with its own message id, with no template in front", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), all(w));
      await w.svc.runDue();
      const run = await runOf(tx);
      assert.ok(run.recipientResults.every((r) => parts(r).join() === "SKIPPED,SENT,SENT"));
      assert.ok(run.recipientResults.every((r) => r.txtProviderMessageId && r.docProviderMessageId && r.txtProviderMessageId !== r.docProviderMessageId));
      assert.equal(run.status, "SENT");
      assert.equal(w.wa.state.sent.length, 0);
      assert.match(w.wa.details.texts[0]!.text, /^\*AYUSHWELLNESS \| DAILY TEAM REPORT\*\nDate: 23 Oct 2026\nTimezone: Asia\/Kolkata\n\n\*TEAM OVERVIEW\*\nOrders: 2\nRevenue: /);
      assert.match(w.wa.details.texts[0]!.text, /\n\n\*TELECALLER PERFORMANCE\*\n\n\*Asha\*\nOrders: 2 \| Revenue: /);
      assert.ok(w.wa.details.texts[0]!.text.split("\n").length > 15 && !w.wa.details.texts[0]!.text.includes("||"), "a readable multi-line report, not one flattened line");
    });
  });

  it("CLOSED 24-hour window: the free-form text and the Excel are NOT attempted and are Failed with the exact restriction; the template notification says so and still goes out; others are unaffected", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, all(w));
      w.wa.details.closed.add(A);
      await w.svc.runDue();
      const run = await runOf(tx);
      const ra = run.recipientResults.find((r) => r.phone === A)!;
      const rb = run.recipientResults.find((r) => r.phone === B)!;
      assert.deepEqual([parts(ra), parts(rb)], [["SENT", "FAILED", "FAILED"], ["SKIPPED", "SENT", "SENT"]]);
      assert.match(ra.txtError ?? "", /24 hours of the recipient's last message.*Nothing was sent.*Retry/);
      assert.equal(ra.docError, ra.txtError);
      assert.equal(w.wa.details.calls.includes(A), false, "no unsupported free-form attempt");
      assert.equal(w.wa.docs.calls.includes(A), false);
      assert.match(w.wa.state.sent.find((s) => s.recipient === A)!.text, /24-hour window for this number is closed: reply to this number/);
      assert.equal(w.wa.state.sent.some((s) => s.recipient === B), false, "the open-window recipient gets no template message");
      assert.equal(run.status, "FAILED", "the run is not shown as fully successful");
      await w.svc.runDue(); // not auto-retried
      assert.equal(w.wa.details.calls.filter((p) => p === A).length, 0);
      // once the recipient has written to the business number, each failed part is retried on its own and the notification is never repeated
      w.wa.details.closed.clear();
      const row = (await w.svc.history(a, 1, 10)).items[0]!.recipients.find((r) => r.name === "Owner")!;
      assert.deepEqual([row.detail.canRetry, row.document.canRetry, row.canRetry], [true, true, false]);
      const notes = w.wa.state.calls.length;
      await w.svc.retryRecipient(a, row.id, "DETAIL");
      let after = (await w.svc.history(a, 1, 10)).items[0]!.recipients.find((r) => r.name === "Owner")!;
      assert.deepEqual([after.detail.status, after.document.status], ["SENT", "FAILED"]);
      await w.svc.retryRecipient(a, row.id, "DOCUMENT");
      after = (await w.svc.history(a, 1, 10)).items[0]!.recipients.find((r) => r.name === "Owner")!;
      assert.deepEqual([after.status, after.detail.status, after.document.status], ["SENT", "SENT", "SENT"]);
      assert.equal(w.wa.state.calls.length, notes, "the template notification was not sent again");
      assert.equal((await runOf(tx)).status, "SENT");
    });
  });

  it("the DEFAULT window check looks for an inbound Meta message from that number in the last 24 hours", async () => {
    await inRollback(async (tx) => {
      const now = at(T_1815);
      assert.equal(await customerWindowOpen(tx, A, now), false);
      await tx.whatsAppMessage.create({ data: { provider: "META", direction: "INBOUND", status: "RECEIVED", normalizedContact: A, fromNumber: A, receivedAt: new Date(now.getTime() - 3 * 3600_000) } });
      assert.equal(await customerWindowOpen(tx, A, now), true);
      assert.equal(await customerWindowOpen(tx, A, new Date(now.getTime() + 22 * 3600_000)), false, "25 hours after their message the window has closed");
      assert.equal(await customerWindowOpen(tx, B, now), false, "another number is unaffected");
    });
  });

  it("a refused detailed text is Failed and retried alone; a timeout is Outcome unknown and is never re-sent; neither disturbs the other messages", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, all(w));
      w.wa.details.modes[A] = "refuse";
      w.wa.details.modes[B] = "timeout";
      await w.svc.runDue();
      const run = await runOf(tx);
      const ra = run.recipientResults.find((r) => r.phone === A)!;
      const rb = run.recipientResults.find((r) => r.phone === B)!;
      assert.deepEqual([parts(ra), parts(rb)], [["SKIPPED", "FAILED", "SENT"], ["SKIPPED", "UNCERTAIN", "SENT"]]);
      assert.match(rb.txtError ?? "", /may have been delivered/);
      w.wa.details.modes = {};
      w.clock.now = at("2026-10-23T14:00:00Z");
      await w.svc.runDue();
      assert.equal(w.wa.details.calls.filter((p) => p === B).length, 1, "unknown outcome: not re-sent");
      const hist = (await w.svc.history(a, 1, 10)).items[0]!.recipients;
      await assert.rejects(() => w.svc.retryRecipient(a, hist.find((r) => r.name === "Ops")!.id, "DETAIL"), /never sent again automatically/);
      const sentNotes = w.wa.state.calls.length;
      await w.svc.retryRecipient(a, hist.find((r) => r.name === "Owner")!.id, "DETAIL");
      assert.equal(w.wa.state.calls.length, sentNotes);
      assert.equal(w.wa.docs.calls.filter((p) => p === A).length, 1);
      await assert.rejects(() => w.svc.retryRecipient(a, hist.find((r) => r.name === "Owner")!.id, "DETAIL"), /definitely failed/);
    });
  });

  it("DETAIL delivery callbacks update only the detailed-text part, by its own message id", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), { ...all(w), recipients: [{ name: "Owner", phone: A }] });
      await w.svc.runDue();
      const r0 = (await runOf(tx)).recipientResults[0]!;
      await applyReportDeliveryStatus(tx, "META", { providerMessageId: r0.txtProviderMessageId!, status: "READ", timestamp: at("2026-10-23T12:50:00Z") });
      const r1 = await tx.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: r0.id } });
      assert.deepEqual(parts(r1), ["SKIPPED", "READ", "SENT"]);
    });
  });
});

describe("saved schedule, last scheduled attempt and skip reasons", () => {
  it("Save persists enabled, 18:15, Asia/Kolkata, template + language, recipients and report contents exactly, and reload returns them", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      const body = { enabled: true, recipients: [{ name: "Owner", phone: A }], sendTime: "18:15", timezone: IST, reportFor: "YESTERDAY" as const, templateName: "daily_team_report1", languageCode: "en", options: { teamSummary: false, calls: true, leads: false, sales: true, followUps: false }, includedUserIds: [] as string[], sendText: true, sendExcel: true };
      assert.ifError(validateConfigInput(body).error);
      await w.svc.saveConfig(a, body);
      const cfg = await w.svc.getConfig(a);
      assert.deepEqual([cfg.enabled, cfg.sendTime, cfg.timezone, cfg.reportFor, cfg.templateName, cfg.languageCode, cfg.sendText, cfg.sendExcel], [true, "18:15", IST, "YESTERDAY", "daily_team_report1", "en", true, true]);
      assert.deepEqual(cfg.options, body.options);
      assert.deepEqual(cfg.recipients.map((r) => [r.name, r.phone]), [["Owner", A]]);
      // saving again with the switch off turns it off and the status says so
      await w.svc.saveConfig(a, { ...body, enabled: false });
      assert.equal((await w.svc.getConfig(a)).enabled, false);
      assert.match((await w.svc.status(a)).nextRun.reason ?? "", /turned OFF/);
    });
  });

  it("the status reports the last SCHEDULED attempt and its result separately from manual tests, and a failing run shows why", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, w.config);
      assert.equal((await w.svc.status(a)).lastScheduled, null);
      await w.svc.sendTest(a);
      assert.equal((await w.svc.status(a)).lastScheduled, null, "a manual test is not a scheduled attempt");
      w.wa.state.modes[A] = "refuse";
      await w.svc.runDue();
      const last = (await w.svc.status(a)).lastScheduled!;
      assert.deepEqual([last.kind, last.reportDate, last.status], ["SCHEDULED", "2026-10-23", "FAILED"]);
      assert.match(last.recipients.find((r) => r.name === "Owner")!.error ?? "", /not approved by Meta/);
    });
  });
});

describe("dynamic schedule: the SAVED time and timezone decide, nothing is hard-coded", () => {
  const cfg = (w: Awaited<ReturnType<typeof world>>, sendTime: string, timezone: string, extra: object = {}) => ({ ...w.config, sendTime, timezone, ...extra });
  const nextAt = async (w: Awaited<ReturnType<typeof world>>) => (await w.svc.status(w.as(w.admin, Role.ADMIN))).nextRun;

  it("different saved times and timezones round-trip, and the next run follows them (before the time, after the time, and across the UTC date line)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, "2026-10-23T12:00:00Z");
      const a = w.as(w.admin, Role.ADMIN);
      // New York (UTC-4 in October): 09:05 local is 13:05Z, still ahead of 12:00Z
      await w.svc.saveConfig(a, cfg(w, "09:05", "America/New_York"));
      assert.deepEqual([(await w.svc.getConfig(a)).sendTime, (await w.svc.getConfig(a)).timezone], ["09:05", "America/New_York"]);
      assert.equal((await nextAt(w)).at?.toISOString(), "2026-10-23T13:05:00.000Z");
      // changing ONLY the time moves the next run; 07:30 New York already passed today (08:00 local) and was saved after it, so the next one is tomorrow
      await w.svc.saveConfig(a, cfg(w, "07:30", "America/New_York"));
      assert.equal((await nextAt(w)).at?.toISOString(), "2026-10-24T11:30:00.000Z");
      await w.svc.saveConfig(a, cfg(w, "09:00", "America/New_York"));
      assert.equal((await nextAt(w)).at?.toISOString(), "2026-10-23T13:00:00.000Z");
      // changing ONLY the timezone recalculates: 09:00 in Kolkata is 03:30Z, already past -> tomorrow
      await w.svc.saveConfig(a, cfg(w, "09:00", "Asia/Kolkata"));
      assert.equal((await nextAt(w)).at?.toISOString(), "2026-10-24T03:30:00.000Z");
      // Auckland is on the next calendar day at 12:00Z (01:00 on the 24th): 23:50 local is 10:50Z on the 24th
      await w.svc.saveConfig(a, cfg(w, "23:50", "Pacific/Auckland"));
      assert.equal((await nextAt(w)).at?.toISOString(), "2026-10-24T10:50:00.000Z");
    });
  });

  it("the exact boundary: nothing before the saved local time (even by a millisecond), the run at it - for a time that is not 18:15 and a zone that is not Kolkata", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, "2026-03-10T14:29:59.999Z");
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), cfg(w, "10:30", "America/New_York")); // EDT (UTC-4) from 8 March -> 14:30Z
      assert.deepEqual(await w.svc.runDue(), { checked: 1, started: 0 });
      assert.equal(await tx.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 0);
      w.clock.now = at("2026-03-10T14:30:00.000Z");
      assert.equal((await w.svc.runDue()).started, 1);
      assert.equal((await runOf(tx)).reportDate, "2026-03-10");
    });
  });

  it("daylight saving is honoured: the same saved wall-clock time is a different UTC instant in winter and summer", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, "2026-01-15T00:00:00Z");
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), cfg(w, "09:00", "America/New_York"));
      assert.equal((await nextAt(w)).at?.toISOString(), "2026-01-15T14:00:00.000Z", "EST = UTC-5");
      w.clock.now = at("2026-07-15T00:00:00Z");
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), cfg(w, "09:00", "America/New_York"));
      assert.equal((await nextAt(w)).at?.toISOString(), "2026-07-15T13:00:00.000Z", "EDT = UTC-4");
    });
  });

  it("midnight and the UTC date line: the report is for the LOCAL day of the occurrence, also when the catch-up tick lands after local midnight", async () => {
    await inRollback(async (tx) => {
      // Auckland 07:00 is 18:00Z of the PREVIOUS UTC day: the local date, not the UTC date, is the report date
      const w = await world(tx, "2026-10-23T17:59:00Z");
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), cfg(w, "07:00", "Pacific/Auckland"));
      w.clock.now = at("2026-10-23T18:00:00Z");
      await w.svc.runDue();
      assert.equal((await runOf(tx)).reportDate, "2026-10-24");
    });
    await inRollback(async (tx) => {
      // 23:55 Kolkata saved at 22:30; the server comes back at 00:20 the next local day: still the 23rd's report, sent once
      const w = await world(tx, "2026-10-23T17:00:00Z");
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), cfg(w, "23:55", "Asia/Kolkata"));
      w.clock.now = at("2026-10-23T18:50:00Z"); // 00:20 IST on the 24th
      await w.svc.runDue();
      await w.svc.runDue();
      const runs = await tx.reportDelivery.findMany({ where: { kind: "SCHEDULED" } });
      assert.deepEqual(runs.map((r) => r.reportDate), ["2026-10-23"]);
    });
    await inRollback(async (tx) => {
      // "previous day" coverage: sent at 00:10 on the 24th it reports the 23rd
      const w = await world(tx, "2026-10-23T18:00:00Z");
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), cfg(w, "00:10", "Asia/Kolkata", { reportFor: "YESTERDAY" }));
      w.clock.now = at("2026-10-23T18:40:00Z"); // 00:10 IST on the 24th
      await w.svc.runDue();
      assert.equal((await runOf(tx)).reportDate, "2026-10-23");
    });
  });

  it("changing the saved time the same day is a NEW occurrence sent at its new time; the old one is never repeated; saving AFTER today's time defers to tomorrow instead of firing at once", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, "2026-10-23T05:00:00Z");
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, cfg(w, "11:00", "Asia/Kolkata")); // 05:30Z
      w.clock.now = at("2026-10-23T05:31:00Z");
      assert.equal((await w.svc.runDue()).started, 1);
      await w.svc.saveConfig(a, cfg(w, "11:10", "Asia/Kolkata")); // re-saved at 11:01 local with a later time
      assert.equal((await nextAt(w)).at?.toISOString(), "2026-10-23T05:40:00.000Z", "today at the NEW time, not tomorrow");
      w.clock.now = at("2026-10-23T05:39:59Z");
      assert.equal((await w.svc.runDue()).started, 0);
      w.clock.now = at("2026-10-23T05:40:00Z");
      assert.equal((await w.svc.runDue()).started, 1);
      await w.svc.runDue();
      await w.mk().runDue();
      assert.equal(await tx.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 2, "one run per occurrence, however many ticks");
      // saved after its own time today -> not sent now, next is tomorrow
      await w.svc.saveConfig(a, cfg(w, "11:05", "Asia/Kolkata"));
      assert.equal((await w.svc.runDue()).started, 0);
      assert.equal((await nextAt(w)).at?.toISOString(), "2026-10-24T05:35:00.000Z");
    });
  });

  it("disabled automation never runs; invalid time or timezone is refused and the saved settings stay exactly as they were", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, T_1815);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, { ...w.config, enabled: false });
      w.clock.now = at("2026-10-23T20:00:00Z");
      assert.deepEqual(await w.svc.runDue(), { checked: 0, started: 0 });
      assert.equal(await tx.reportDelivery.count(), 0);
      const body = (over: object) => ({ ...w.config, ...over });
      for (const bad of [{ sendTime: "25:61" }, { sendTime: "9pm" }, { sendTime: "" }, { timezone: "Mars/Olympus" }, { timezone: "IST" }, { timezone: "" }]) {
        assert.ok(validateConfigInput(body(bad)).error, JSON.stringify(bad));
      }
      assert.deepEqual([(await w.svc.getConfig(a)).enabled, (await w.svc.getConfig(a)).sendTime], [false, "18:15"], "nothing was changed by the refused inputs");
    });
  });

  it("BOUNDED catch-up: a restart within 3 hours still sends; later than that the occurrence is recorded as Missed - once, visibly, never sent late; a settings save after the time schedules nothing for it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, "2026-10-23T12:00:00Z");
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), w.config); // 18:15 IST = 12:45Z
      w.clock.now = at("2026-10-23T15:44:00Z"); // 2h59m late
      assert.equal((await w.svc.runDue()).started, 1);
      assert.equal(w.wa.state.sent.length, 2);
    });
    await inRollback(async (tx) => {
      const w = await world(tx, "2026-10-23T12:00:00Z");
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, w.config);
      w.clock.now = at("2026-10-23T15:46:00Z"); // 3h01m late
      assert.equal((await w.svc.runDue()).started, 0);
      await w.svc.runDue();
      await w.mk().runDue();
      const run = await runOf(tx);
      assert.equal(run.status, "FAILED");
      assert.ok(run.recipientResults.every((r) => r.status === "FAILED" && r.txtStatus === "FAILED" && r.docStatus === "FAILED" && /Missed.*not sent late/.test(r.error ?? "")));
      assert.equal(w.wa.state.calls.length + w.wa.details.calls.length + w.wa.docs.calls.length, 0, "nothing was sent late");
      assert.equal(await tx.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 1, "recorded once");
      const last = (await w.svc.status(a)).lastScheduled!;
      assert.match(last.recipients[0]!.error ?? "", /Missed/);
      assert.equal((await nextAt(w)).at?.toISOString(), "2026-10-24T12:45:00.000Z");
    });
    await inRollback(async (tx) => {
      const w = await world(tx, "2026-10-23T13:30:00Z"); // saved at 19:00 IST, after the 18:15 time
      await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), w.config);
      assert.equal((await w.svc.runDue()).started, 0);
      assert.equal(await tx.reportDelivery.count(), 0, "not even a Missed record: these settings never scheduled today's occurrence");
      assert.equal((await nextAt(w)).at?.toISOString(), "2026-10-24T12:45:00.000Z");
    });
  });

  it("the scheduler reads the settings saved NOW on every tick: a change made between two ticks is used by the next one", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, "2026-10-23T12:00:00Z");
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, cfg(w, "20:00", "Asia/Kolkata")); // 14:30Z
      w.clock.now = at("2026-10-23T12:46:00Z");
      assert.equal((await w.svc.runDue()).started, 0);
      await w.svc.saveConfig(a, cfg(w, "18:16", "Asia/Kolkata")); // moved to 12:46Z: saved at that same instant
      assert.equal((await w.svc.runDue()).started, 1, "the new saved time is used without a restart");
      assert.equal((await runOf(tx)).dedupeKey?.endsWith(":2026-10-23:18:16:2026-10-23"), true);
    });
  });

  it("a successful manual test never counts as, blocks or replaces the scheduled run", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, T_1815);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, w.config);
      await w.svc.sendTest(a);
      assert.equal((await w.svc.status(a)).lastScheduled, null);
      assert.equal((await w.svc.status(a)).nextRun.dueNow, true, "a test does not satisfy the schedule");
      assert.equal((await w.svc.runDue()).started, 1);
      assert.equal(await tx.reportDelivery.count({ where: { kind: "TEST" } }), 1);
      assert.equal(await tx.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 1);
    });
  });
});

describe("saved roster through the service", () => {
  const twoPeople = [
    { id: "11111111-1111-4111-8111-111111111111", name: "Aayush Tiwari", leads: 9, contacted: 8, interested: 4, converted: 1, calls: 18, connected: 8, talkTimeSec: 360, orders: 2, revenue: 1298 },
    { id: "22222222-2222-4222-8222-222222222222", name: "Test1", leads: 50, contacted: 40, interested: 30, converted: 20, calls: 200, connected: 100, talkTimeSec: 9000, orders: 9, revenue: 9999 },
  ];
  const withPeople = (tx: Prisma.TransactionClient, start = T_1815) => world(tx, start).then((w) => {
    const svc = new ReportAutomationService(tx, { now: () => w.clock.now, sources: { overview: async () => twoPeople as never, cancelledByUser: async () => new Map(), pendingFollowUps: async () => new Map() }, send: w.wa.send, sendDocument: w.wa.sendDocument, sendDetail: w.wa.sendDetail, windowOpen: w.wa.windowOpen });
    return { ...w, svc };
  });

  it("the roster is saved, reloaded, applied to the preview, and the scheduled report and Excel contain only the roster; clearing it restores everyone", async () => {
    await inRollback(async (tx) => {
      const w = await withPeople(tx);
      const a = w.as(w.admin, Role.ADMIN);
      w.wa.details.closed.clear();
      await w.svc.saveConfig(a, { ...w.config, sendExcel: true, includedUserIds: [twoPeople[0]!.id] });
      assert.deepEqual((await w.svc.getConfig(a)).includedUserIds, [twoPeople[0]!.id]);
      const preview = await w.svc.preview(a, "2026-10-23");
      assert.ok(!/Test1/.test(preview.text + preview.whatsappText));
      assert.deepEqual([preview.data.people.length, preview.data.team.orders, preview.data.scope.length], [1, 2, 2]);
      await w.svc.runDue();
      assert.ok(!/Test1/.test(w.wa.details.texts.map((t) => t.text).join()));
      assert.match(w.wa.details.texts[0]!.text, /\*TEAM OVERVIEW\*\nOrders: 2\nRevenue: ₹1,298/);
      assert.equal(w.wa.docs.files.length, 2);
      await w.svc.saveConfig(a, { ...w.config, includedUserIds: [] });
      assert.equal((await w.svc.preview(a, "2026-10-23")).data.people.length, 2);
    });
  });

  it("the validator accepts only user ids", () => {
    const base = { enabled: false, recipients: [], sendTime: "18:15", timezone: IST, reportFor: "TODAY", templateName: "", languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true } };
    assert.ifError(validateConfigInput({ ...base, includedUserIds: [twoPeople[0]!.id] }).error);
    assert.ok(validateConfigInput({ ...base, includedUserIds: ["Aayush Tiwari"] }).error, "names are not accepted - ids only");
  });
});

describe("saved data date through the service (persistence, preview, scheduled run, test send, retry)", () => {
  /** Remembers the period each report was built for, so the service's choices can be asserted. */
  const recording = () => {
    const asked: { from: string; to: string }[] = [];
    const src: ReportSources = { overview: async (_v, from, to) => { asked.push({ from, to }); return people as never; }, cancelledByUser: async () => new Map(), pendingFollowUps: async () => new Map() };
    return { asked, src };
  };
  const make = async (tx: Prisma.TransactionClient, start: string) => {
    const w = await world(tx, start);
    const rec = recording();
    const svc = new ReportAutomationService(tx, { now: () => w.clock.now, sources: rec.src, send: w.wa.send, sendDocument: w.wa.sendDocument, sendDetail: w.wa.sendDetail, windowOpen: w.wa.windowOpen });
    return { ...w, svc, rec };
  };
  const body = (w: { config: object }, over: object): ConfigInput => ({ ...w.config, includedUserIds: [] as string[], ...over }) as ConfigInput;

  it("each mode is saved and reloaded exactly; the specific date survives; changing only the SEND time keeps the data date", async () => {
    await inRollback(async (tx) => {
      const w = await make(tx, "2026-10-24T05:00:00Z");
      const a = w.as(w.admin, Role.ADMIN);
      for (const mode of ["TODAY", "YESTERDAY", "LAST7DAYS"] as const) {
        await w.svc.saveConfig(a, body(w, { reportFor: mode }));
        assert.deepEqual([(await w.svc.getConfig(a)).reportFor, (await w.svc.getConfig(a)).dataDate], [mode, null]);
      }
      await w.svc.saveConfig(a, body(w, { reportFor: "DATE", dataDate: "2026-09-15" }));
      assert.deepEqual([(await w.svc.getConfig(a)).reportFor, (await w.svc.getConfig(a)).dataDate], ["DATE", "2026-09-15"]);
      await w.svc.saveConfig(a, body(w, { reportFor: "DATE", dataDate: "2026-09-15", sendTime: "21:30" }));
      assert.deepEqual([(await w.svc.getConfig(a)).sendTime, (await w.svc.getConfig(a)).dataDate], ["21:30", "2026-09-15"], "the send time changed, the data date did not");
      await w.svc.saveConfig(a, body(w, { reportFor: "YESTERDAY" }));
      assert.equal((await w.svc.getConfig(a)).dataDate, null, "a stale date is not kept once another mode is chosen");
    });
  });

  it("validation: a specific date is required, must be a real calendar day, and cannot be in the future (in the report timezone)", async () => {
    await inRollback(async (tx) => {
      const w = await make(tx, "2026-10-24T05:00:00Z"); // 10:30 IST on the 24th
      const a = w.as(w.admin, Role.ADMIN);
      assert.ok(validateConfigInput(body(w, { reportFor: "DATE" })).error, "DATE without a date");
      assert.ok(validateConfigInput(body(w, { reportFor: "DATE", dataDate: "2026-02-30" })).error);
      assert.ok(validateConfigInput(body(w, { reportFor: "DATE", dataDate: "24/10/2026" })).error);
      assert.ifError(validateConfigInput(body(w, { reportFor: "DATE", dataDate: "2026-10-01" })).error);
      assert.ifError(validateConfigInput(body(w, { reportFor: "LAST7DAYS" })).error);
      assert.ok(validateConfigInput(body(w, { reportFor: "LAST_WEEK" })).error);
      await assert.rejects(() => w.svc.saveConfig(a, body(w, { reportFor: "DATE", dataDate: "2026-10-25" })), /cannot be in the future/);
      await w.svc.saveConfig(a, body(w, { reportFor: "DATE", dataDate: "2026-10-24" })); // today in IST is fine
      // 20:00Z on the 24th is already the 25th in Kolkata, so the 25th is "today" there
      w.clock.now = at("2026-10-24T20:00:00Z");
      await w.svc.saveConfig(a, body(w, { reportFor: "DATE", dataDate: "2026-10-25" }));
    });
  });

  it("the preview uses the SAVED selection; an explicit date previews just that day", async () => {
    await inRollback(async (tx) => {
      const w = await make(tx, "2026-10-24T05:00:00Z");
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, body(w, { reportFor: "LAST7DAYS" }));
      const p = await w.svc.preview(a);
      assert.deepEqual([p.reportFrom, p.reportDate, p.data.from, p.data.to], ["2026-10-17", "2026-10-23", "2026-10-17", "2026-10-23"]);
      assert.match(p.text, /\nPeriod: 17 Oct 2026 to 23 Oct 2026\n/);
      assert.match(p.whatsappText, /Team report for 17 Oct 2026 - 23 Oct 2026/);
      await w.svc.saveConfig(a, body(w, { reportFor: "DATE", dataDate: "2026-09-15" }));
      assert.match((await w.svc.preview(a)).text, /\nDate: 15 Sept? 2026\n/);
      assert.match((await w.svc.preview(a, "2026-10-01")).text, /\nDate: 01 Oct 2026\n/);
    });
  });

  it("the SCHEDULED run uses the saved period relative to its own occurrence day: Today, Yesterday, 7 days and a historical date sent days later; the detailed text and Excel agree", async () => {
    const cases: [object, string, string, string][] = [
      [{ reportFor: "TODAY" }, "2026-10-23", "2026-10-23", "Date: 23 Oct 2026"],
      [{ reportFor: "YESTERDAY" }, "2026-10-22", "2026-10-22", "Date: 22 Oct 2026"],
      [{ reportFor: "LAST7DAYS" }, "2026-10-16", "2026-10-22", "Period: 16 Oct 2026 to 22 Oct 2026"],
      [{ reportFor: "DATE", dataDate: "2026-09-15" }, "2026-09-15", "2026-09-15", "Date: 15 Sept 2026"],
    ];
    for (const [over, from, to, header] of cases) {
      await inRollback(async (tx) => {
        const w = await make(tx, T_1815);
        w.wa.details.closed.clear();
        await w.svc.saveConfig(w.as(w.admin, Role.ADMIN), body(w, { ...over, sendExcel: true }));
        await w.svc.runDue();
        const run = await runOf(tx);
        assert.deepEqual([run.reportDate, run.reportRangeStart ?? run.reportDate], [to, from], JSON.stringify(over));
        assert.deepEqual(w.rec.asked.at(-1), { from, to });
        assert.ok(w.wa.details.texts[0]!.text.includes(`\n${header}\n`), header);
        const expectedName = from === to ? `AyushWellness_Daily_Report_${to}.xlsx` : `AyushWellness_Daily_Report_${from}_to_${to}.xlsx`;
        assert.equal(w.wa.docs.files[0]!.filename, expectedName);
      });
    }
  });

  it("a saved historical date is the report date even when the scheduler runs weeks later; changing the send time never changes it; the unsaved value is never used", async () => {
    await inRollback(async (tx) => {
      const w = await make(tx, "2026-10-20T05:00:00Z");
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, body(w, { reportFor: "DATE", dataDate: "2026-09-15", sendTime: "18:15" }));
      w.clock.now = at("2026-10-20T12:45:00Z"); // five weeks after the data date, 18:15 IST
      await w.svc.runDue();
      assert.equal((await runOf(tx)).reportDate, "2026-09-15");
      await w.svc.saveConfig(a, body(w, { reportFor: "DATE", dataDate: "2026-09-15", sendTime: "19:00" })); // only the send time moved
      assert.equal((await w.svc.getConfig(a)).dataDate, "2026-09-15");
      w.clock.now = at("2026-10-20T13:30:00Z");
      await w.svc.runDue();
      assert.deepEqual((await tx.reportDelivery.findMany({ where: { kind: "SCHEDULED" } })).map((r) => r.reportDate), ["2026-09-15", "2026-09-15"]);
      // a "draft" that was never saved cannot reach the scheduler: only the stored row is read
      w.rec.asked.length = 0;
      w.clock.now = at("2026-10-21T13:30:00Z"); // 19:00 IST, the saved send time
      await w.svc.runDue();
      assert.deepEqual(w.rec.asked.at(-1), { from: "2026-09-15", to: "2026-09-15" });
    });
  });

  it("timezone boundaries: 'yesterday' and 'previous 7 days' follow the SAVED zone, not UTC", async () => {
    await inRollback(async (tx) => {
      // 19:00Z on the 23rd is 00:30 on the 24th in Kolkata but still the 23rd in UTC
      const w = await make(tx, "2026-10-23T18:00:00Z");
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, body(w, { reportFor: "YESTERDAY", sendTime: "00:30", timezone: IST }));
      w.clock.now = at("2026-10-23T19:00:00Z");
      await w.svc.runDue();
      assert.equal((await runOf(tx)).reportDate, "2026-10-23", "yesterday relative to the 24th in Kolkata");
    });
    await inRollback(async (tx) => {
      const w = await make(tx, "2026-10-24T03:00:00Z");
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, body(w, { reportFor: "LAST7DAYS", sendTime: "09:00", timezone: "Pacific/Auckland" })); // 09:00 NZDT = 20:00Z the day before
      w.clock.now = at("2026-10-24T20:00:00Z"); // 09:00 on the 25th in Auckland
      await w.svc.runDue();
      const run = await runOf(tx);
      assert.deepEqual([run.reportRangeStart, run.reportDate], ["2026-10-18", "2026-10-24"]);
    });
  });

  it("a retry rebuilds the SAME period the run was created for, and a test send uses the saved selection with its own TEST run", async () => {
    await inRollback(async (tx) => {
      const w = await make(tx, T_1815);
      const a = w.as(w.admin, Role.ADMIN);
      w.wa.details.closed.add(A); // A: template path
      await w.svc.saveConfig(a, body(w, { reportFor: "LAST7DAYS", sendExcel: true }));
      w.wa.state.modes[A] = "refuse";
      await w.svc.runDue();
      const hist = (await w.svc.history(a, 1, 5)).items[0]!;
      assert.deepEqual([hist.reportFrom, hist.reportDate], ["2026-10-16", "2026-10-22"], "history metadata carries the range");
      // the saved selection changes AFTER the run; the retry must still cover the run's own period
      await w.svc.saveConfig(a, body(w, { reportFor: "TODAY", sendExcel: true }));
      w.wa.state.modes = {};
      w.rec.asked.length = 0;
      await w.svc.retryRecipient(a, hist.recipients.find((r) => r.name === "Owner")!.id, "TEXT");
      assert.deepEqual(w.rec.asked.at(-1), { from: "2026-10-16", to: "2026-10-22" });
      assert.match(w.wa.state.sent.at(-1)!.text, /Team report for 16 Oct 2026 - 22 Oct 2026/);
      // a test send follows the CURRENT saved selection (today) and is a separate TEST run
      const test = await w.svc.sendTest(a);
      assert.deepEqual([test.kind, test.reportDate, test.reportFrom], ["TEST", "2026-10-23", "2026-10-23"]);
    });
  });

  it("changing only the data date is a new occurrence the same day (it is sent), repeated ticks are not", async () => {
    await inRollback(async (tx) => {
      const w = await make(tx, T_1815);
      const a = w.as(w.admin, Role.ADMIN);
      await w.svc.saveConfig(a, body(w, { reportFor: "TODAY" }));
      assert.equal((await w.svc.runDue()).started, 1);
      await w.svc.runDue();
      assert.equal(await tx.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 1);
      w.clock.now = at("2026-10-23T12:46:00Z");
      await w.svc.saveConfig(a, body(w, { reportFor: "DATE", dataDate: "2026-10-01" }));
      assert.equal((await w.svc.status(a)).nextRun.at?.toISOString(), "2026-10-24T12:45:00.000Z", "saved after today's time: the new selection starts tomorrow");
    });
  });
});
