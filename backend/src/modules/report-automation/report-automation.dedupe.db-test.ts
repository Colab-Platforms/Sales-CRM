// One report run sends at most one template, one detailed text and one Excel per recipient - however many workers, ticks, retries or webhook deliveries touch it. Real service + schema on the isolated
// database (one rolled-back transaction per test); WhatsApp and the report data are fakes - nothing is sent anywhere.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import ReportAutomationService from "./report-automation.service.js";
import { ReportSendRejected, type ReportDocumentInput, type ReportSendInput } from "./report-automation.sender.js";
import type { ReportSources } from "./report-automation.report.js";
import { applyReportDeliveryStatus } from "./report-automation.status.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const A = "+919876543210";
const T_1815 = "2026-10-23T12:45:00Z"; // 18:15 IST
const people = [{ id: "t1", name: "Asha", leads: 10, contacted: 8, interested: 4, converted: 2, calls: 30, connected: 20, talkTimeSec: 3600, orders: 2, revenue: 1298 }];
const sources: ReportSources = { overview: async () => people as never, cancelledByUser: async () => new Map(), pendingFollowUps: async () => new Map() };

async function setup(tx: Prisma.TransactionClient) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${randomUUID()}`, role: Role.ADMIN } });
  const clock = { now: new Date(T_1815) };
  const sent = { templates: [] as ReportSendInput[], texts: [] as string[], files: [] as ReportDocumentInput[] };
  const mode = { doc: "ok" as "ok" | "refuse" };
  const closed = new Set<string>([A]);
  const svc = new ReportAutomationService(tx, {
    now: () => clock.now, sources,
    send: async (i) => { sent.templates.push(i); return { providerMessageId: `wamid.tpl.${sent.templates.length}`, provider: "META" }; },
    sendDetail: async (i) => { sent.texts.push(i.text); return { providerMessageId: `wamid.txt.${sent.texts.length}`, provider: "META" }; },
    sendDocument: async (i) => { if (mode.doc === "refuse") throw new ReportSendRejected("Meta refused the file"); sent.files.push(i); return { providerMessageId: `wamid.doc.${sent.files.length}`, mediaId: "media.1", provider: "META" }; },
    windowOpen: async (p) => !closed.has(p),
  });
  const actor = { id: admin.id, username: admin.username, role: Role.ADMIN };
  await svc.saveConfig(actor, { enabled: true, recipients: [{ name: "Owner", phone: A }], sendTime: "18:15", timezone: "Asia/Kolkata", reportFor: "TODAY", templateName: "daily_team_report", languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, includedUserIds: [], sendText: true, sendExcel: true });
  const auto = await tx.reportAutomation.findUniqueOrThrow({ where: { ownerId: admin.id } });
  await tx.reportAutomation.update({ where: { id: auto.id }, data: { updatedAt: new Date(clock.now.getTime() - 3_600_000) } });
  await svc.runDue(); // window closed: the template only, the text and the Excel wait for a reply
  await tx.reportDelivery.updateMany({ where: { automationId: auto.id, kind: "SCHEDULED" }, data: { createdAt: clock.now } });
  const run = await tx.reportDelivery.findFirstOrThrow({ where: { automationId: auto.id, kind: "SCHEDULED" } });
  const row = () => tx.reportDeliveryRecipient.findFirstOrThrow({ where: { deliveryId: run.id, phone: A } });
  return { actor, clock, sent, mode, closed, svc, run, row, auto };
}

describe("one Excel per run and recipient", () => {
  it("the scheduled run sends the template once and holds the text and the Excel; repeated ticks add nothing", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      assert.equal(w.sent.templates.length, 1);
      for (let i = 0; i < 3; i++) await w.svc.runDue();
      assert.equal(w.sent.templates.length, 1);
      assert.equal(w.sent.files.length + w.sent.texts.length, 0);
      assert.equal(await tx.reportDelivery.count({ where: { automationId: w.auto.id, kind: "SCHEDULED" } }), 1);
    });
  });

  it("two replies at once (and a duplicate webhook) send the Excel exactly once", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      w.closed.delete(A);
      await Promise.all([w.svc.sendPendingOnReply(A), w.svc.sendPendingOnReply(A)]);
      await w.svc.sendPendingOnReply(A); // the same webhook delivered again
      assert.equal(w.sent.files.length, 1);
      assert.equal(w.sent.texts.length, 1);
      assert.equal(w.sent.templates.length, 1);
      const r = await w.row();
      assert.deepEqual([r.txtStatus, r.docStatus, r.docAttempts], ["SENT", "SENT", 2]); // attempt 1 = the scheduled run (held), attempt 2 = the reply; never a third
    });
  });

  it("THE RACE: a scheduler tick never adopts an Excel another worker is sending (claimed SENDING)", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      w.closed.delete(A);
      const r = await w.row();
      await tx.reportDeliveryRecipient.update({ where: { id: r.id }, data: { docStatus: "SENDING", docAttempts: 1 } }); // another worker's in-flight send
      for (let i = 0; i < 3; i++) await w.svc.runDue();
      assert.equal(w.sent.files.length, 0, "the tick must not send a part someone else claimed");
      // a manual retry of the DETAIL text must not adopt the Excel either
      await tx.reportDeliveryRecipient.update({ where: { id: r.id }, data: { txtStatus: "FAILED", txtError: "x" } });
      await w.svc.retryRecipient(w.actor, r.id, "DETAIL");
      assert.equal(w.sent.files.length, 0);
      assert.equal(w.sent.texts.length, 1);
      assert.equal((await w.row()).docStatus, "SENDING");
    });
  });

  it("retrying a failed Excel sends only the Excel - not the template or the detailed text", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      w.closed.delete(A);
      w.mode.doc = "refuse";
      await w.svc.sendPendingOnReply(A);
      let r = await w.row();
      assert.deepEqual([r.txtStatus, r.docStatus], ["SENT", "FAILED"]);
      assert.deepEqual([w.sent.templates.length, w.sent.texts.length, w.sent.files.length], [1, 1, 0]);
      w.mode.doc = "ok";
      await w.svc.retryRecipient(w.actor, r.id, "DOCUMENT");
      r = await w.row();
      assert.deepEqual([r.status, r.txtStatus, r.docStatus], ["SENT", "SENT", "SENT"]);
      assert.deepEqual([w.sent.templates.length, w.sent.texts.length, w.sent.files.length], [1, 1, 1]);
      // an accepted Excel cannot be retried
      await assert.rejects(w.svc.retryRecipient(w.actor, r.id, "DOCUMENT"), /definitely failed/);
      assert.equal(w.sent.files.length, 1);
    });
  });

  it("provider status callbacks (delivered, read, repeated) never send anything", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      w.closed.delete(A);
      await w.svc.sendPendingOnReply(A);
      for (const status of ["DELIVERED", "READ", "READ", "DELIVERED"] as const) await applyReportDeliveryStatus(tx, "META", { providerMessageId: "wamid.doc.1", status, timestamp: new Date(T_1815) });
      await w.svc.runDue();
      assert.deepEqual([w.sent.templates.length, w.sent.texts.length, w.sent.files.length], [1, 1, 1]);
      assert.equal((await w.row()).docStatus, "READ");
    });
  });

  it("a test send is its own run: it never touches the scheduled run, and does not make the scheduler send again", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      w.closed.delete(A);
      await w.svc.sendTest(w.actor);
      const runs = await tx.reportDelivery.findMany({ where: { automationId: w.auto.id }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(runs.map((r) => r.kind).sort(), ["SCHEDULED", "TEST"]);
      assert.equal(w.sent.files.length, 1); // the test's own Excel
      await w.svc.runDue();
      assert.equal(w.sent.files.length, 1, "the scheduled run's held Excel is not sent by a tick");
      assert.equal((await w.row()).docStatus, "WAITING_FOR_REPLY");
    });
  });
});
