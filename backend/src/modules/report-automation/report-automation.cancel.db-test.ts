// Cancel an upcoming occurrence, pause / resume, and delete from history. Real service + schema on the isolated database (one rolled-back transaction per test); WhatsApp and the report data are fakes.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import ReportAutomationService from "./report-automation.service.js";
import type { ReportDocumentInput, ReportSendInput } from "./report-automation.sender.js";
import type { ReportSources } from "./report-automation.report.js";

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
const D24 = "2026-10-24";
const people = [{ id: "t1", name: "Asha", leads: 10, contacted: 8, interested: 4, converted: 2, calls: 30, connected: 20, talkTimeSec: 3600, orders: 2, revenue: 1298 }];
const sources: ReportSources = { overview: async () => people as never, cancelledByUser: async () => new Map(), pendingFollowUps: async () => new Map() };

async function setup(tx: Prisma.TransactionClient) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${randomUUID()}`, role: Role.ADMIN } });
  const clock = { now: new Date(T_1815) };
  const sent = { templates: [] as ReportSendInput[], texts: [] as string[], files: [] as ReportDocumentInput[] };
  const closed = new Set<string>([A]);
  const svc = new ReportAutomationService(tx, {
    now: () => clock.now, sources,
    send: async (i) => { sent.templates.push(i); return { providerMessageId: `wamid.tpl.${sent.templates.length}`, provider: "META" }; },
    sendDetail: async (i) => { sent.texts.push(i.text); return { providerMessageId: `wamid.txt.${sent.texts.length}`, provider: "META" }; },
    sendDocument: async (i) => { sent.files.push(i); return { providerMessageId: `wamid.doc.${sent.files.length}`, mediaId: "media.1", provider: "META" }; },
    windowOpen: async (p) => !closed.has(p),
  });
  const actor = { id: admin.id, username: admin.username, role: Role.ADMIN } as never as { id: string; username: string; role: typeof Role.ADMIN };
  await svc.saveConfig(actor as never, { enabled: true, recipients: [{ name: "Owner", phone: A }], sendTime: "18:15", timezone: "Asia/Kolkata", reportFor: "TODAY", templateName: "daily_team_report", languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, includedUserIds: [], sendText: true, sendExcel: true });
  const auto = await tx.reportAutomation.findUniqueOrThrow({ where: { ownerId: admin.id } });
  await tx.reportAutomation.update({ where: { id: auto.id }, data: { updatedAt: new Date(clock.now.getTime() - 3_600_000) } });
  await svc.runDue(); // window closed: the template only; the text and the Excel wait for a reply
  await tx.reportDelivery.updateMany({ where: { automationId: auto.id, kind: "SCHEDULED" }, data: { createdAt: clock.now } });
  const run = await tx.reportDelivery.findFirstOrThrow({ where: { automationId: auto.id, kind: "SCHEDULED" } });
  const row = () => tx.reportDeliveryRecipient.findFirstOrThrow({ where: { deliveryId: run.id, phone: A } });
  return { actor: actor as never as Parameters<ReportAutomationService["scheduled"]>[0] & { id: string }, clock, sent, closed, svc, run, row, auto };
}
const manager = (tx: Prisma.TransactionClient) => tx.user.create({ data: { name: "Mgr", username: `m-${randomUUID()}`, role: Role.MANAGER } }).then((u) => ({ id: u.id, username: u.username, role: Role.MANAGER }) as never);

describe("cancel an upcoming occurrence", () => {
  it("is persisted with who/when, shows as Cancelled, is never offered again, and the scheduler neither claims nor sends it", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      assert.equal((await w.svc.scheduled(w.actor)).upcoming.some((u) => u.occurrenceDate === D24 && u.canCancel), true);
      const done = await w.svc.cancelOccurrence(w.actor, D24);
      assert.equal(done.status, "CANCELLED");
      const run = await tx.reportDelivery.findUniqueOrThrow({ where: { id: done.runId } });
      assert.deepEqual([run.status, run.cancelledById, run.cancelledAt instanceof Date], ["CANCELLED", w.actor.id, true]);
      const s = await w.svc.scheduled(w.actor);
      assert.equal(s.upcoming.some((u) => u.occurrenceDate === D24), false, "never regenerated as upcoming");
      assert.equal(s.recent.some((r) => r.status === "CANCELLED" && r.dataTo === D24 && r.cancelledBy === "Admin"), true);
      w.clock.now = new Date("2026-10-24T12:50:00Z"); // 18:20 IST, the day it was due
      for (let i = 0; i < 3; i++) await w.svc.runDue();
      assert.equal(w.sent.templates.length, 1, "nothing new was sent");
      assert.equal(await tx.reportDelivery.count({ where: { dedupeKey: run.dedupeKey } }), 1);
      assert.equal((await tx.reportDelivery.findUniqueOrThrow({ where: { id: run.id } })).status, "CANCELLED");
      assert.equal((await w.svc.status(w.actor)).nextRun.at?.toISOString().slice(0, 10), "2026-10-25");
    });
  });

  it("concurrent cancellation: exactly one of two cancels wins; a run the scheduler already started cannot be cancelled", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const r = await Promise.allSettled([w.svc.cancelOccurrence(w.actor, D24), w.svc.cancelOccurrence(w.actor, D24)]);
      assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
      const d25 = "2026-10-25";
      w.clock.now = new Date("2026-10-25T12:50:00Z");
      await w.svc.runDue(); // the scheduler claims 25 Oct first
      const started = await tx.reportDelivery.findFirstOrThrow({ where: { reportDate: d25, kind: "SCHEDULED" } });
      await assert.rejects(w.svc.cancelOccurrence(w.actor, d25), /already started/);
      assert.notEqual((await tx.reportDelivery.findUniqueOrThrow({ where: { id: started.id } })).status, "CANCELLED");
    });
  });

  it("only an Admin can cancel; a past or unknown occurrence is refused", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      await assert.rejects(w.svc.cancelOccurrence(await manager(tx), D24), /Only an Admin/);
      await assert.rejects(w.svc.cancelOccurrence(w.actor, "2026-10-01"), /not an upcoming/);
      assert.equal(await tx.reportDelivery.count({ where: { status: "CANCELLED" } }), 0);
    });
  });

  it("a cancelled run cannot be retried, and a reply releases only the real held run", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const { runId } = await w.svc.cancelOccurrence(w.actor, D24);
      const row = await tx.reportDeliveryRecipient.findFirstOrThrow({ where: { deliveryId: runId } });
      await assert.rejects(w.svc.retryRecipient(w.actor, row.id, "DOCUMENT"), /cancelled/);
      w.closed.delete(A);
      const o = await w.svc.sendPendingOnReply(A);
      assert.equal(o.runId, w.run.id);
      assert.equal(w.sent.files.length, 1);
      assert.equal((await tx.reportDelivery.findUniqueOrThrow({ where: { id: runId } })).status, "CANCELLED");
    });
  });
});

describe("pause and resume the recurring automation", () => {
  it("off: nothing is scheduled or sent and history is unchanged; on again: a time that passed while off is not sent late, the next day sends", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const before = await tx.reportDelivery.count({});
      await w.svc.setEnabled(w.actor, false);
      assert.equal((await w.svc.scheduled(w.actor)).upcoming.length, 0);
      w.clock.now = new Date("2026-10-24T12:50:00Z");
      await w.svc.runDue();
      assert.equal(await tx.reportDelivery.count({}), before);
      assert.equal((await w.row()).status, "SENT"); // history untouched
      const cfg = await w.svc.setEnabled(w.actor, true);
      assert.equal(cfg.enabled, true);
      await w.svc.runDue();
      assert.equal(w.sent.templates.length, 1, "24 Oct 18:15 passed while it was off - not sent late");
      assert.equal((await w.svc.scheduled(w.actor)).upcoming[0]!.occurrenceDate, "2026-10-25");
      w.clock.now = new Date("2026-10-25T12:50:00Z");
      await w.svc.runDue();
      assert.equal(w.sent.templates.length, 2);
    });
  });
  it("a salesperson cannot toggle it", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      await assert.rejects(w.svc.setEnabled({ id: w.actor.id, username: "x", role: Role.SALESPERSON } as never, false), /Forbidden/);
    });
  });
});

describe("delete from history (soft delete)", () => {
  it("hides a finished run, records who/when, changes nothing else, and never resends or recreates it", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      w.closed.delete(A);
      await w.svc.sendPendingOnReply(A);
      const before = await w.row();
      const sentBefore = [w.sent.templates.length, w.sent.texts.length, w.sent.files.length];
      assert.equal((await w.svc.deleteRun(w.actor, w.run.id)).deleted, true);
      const run = await tx.reportDelivery.findUniqueOrThrow({ where: { id: w.run.id } });
      assert.deepEqual([run.deletedById, run.deletedAt instanceof Date], [w.actor.id, true]);
      const after = await w.row();
      assert.deepEqual([after.status, after.txtStatus, after.docStatus, after.docProviderMessageId], [before.status, before.txtStatus, before.docStatus, before.docProviderMessageId]);
      assert.equal((await w.svc.history(w.actor, 1, 20)).items.some((i) => i.id === w.run.id), false);
      assert.equal((await w.svc.scheduled(w.actor)).recent.some((r) => r.runId === w.run.id), false);
      for (let i = 0; i < 3; i++) await w.svc.runDue();
      assert.deepEqual([w.sent.templates.length, w.sent.texts.length, w.sent.files.length], sentBefore);
      assert.equal(await tx.reportDelivery.count({ where: { automationId: w.auto.id, kind: "SCHEDULED" } }), 1, "not recreated");
      await assert.rejects(w.svc.deleteRun(w.actor, w.run.id), /not found/);
    });
  });
  it("refuses an active run: waiting for a reply, or mid-send", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx); // text and Excel wait for a reply
      await assert.rejects(w.svc.deleteRun(w.actor, w.run.id), /cannot be removed/);
      await tx.reportDeliveryRecipient.update({ where: { id: (await w.row()).id }, data: { docStatus: "SENDING" } });
      await assert.rejects(w.svc.deleteRun(w.actor, w.run.id), /cannot be removed/);
      assert.equal((await tx.reportDelivery.findUniqueOrThrow({ where: { id: w.run.id } })).deletedAt, null);
      const rows = (await w.svc.scheduled(w.actor)).recent.filter((x) => x.runId === w.run.id);
      assert.equal(rows.length > 0 && rows.every((x) => x.canDelete === false && Boolean(x.deleteBlockedReason)), true);
    });
  });
  it("only an Admin may delete, and only their own automation's runs", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      w.closed.delete(A);
      await w.svc.sendPendingOnReply(A);
      await assert.rejects(w.svc.deleteRun(await manager(tx), w.run.id), /Only an Admin/);
      const other = await tx.user.create({ data: { name: "Other", username: `o-${randomUUID()}`, role: Role.ADMIN } });
      await assert.rejects(w.svc.deleteRun({ id: other.id, username: other.username, role: Role.ADMIN } as never, w.run.id), /not found/);
    });
  });
});

describe("regression: cancelled dates never reappear in Upcoming", () => {
  it("cancelling 24, 26 and 28 Oct leaves 25, 27, 29 (nothing else cancelled), survives a fresh service, a later tick and a refreshed query, and stays listed as cancelled", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const dates = async (svc: ReportAutomationService) => (await svc.scheduled(w.actor)).upcoming.map((u) => u.occurrenceDate);
      assert.deepEqual([...new Set(await dates(w.svc))], ["2026-10-24", "2026-10-25", "2026-10-26"]);
      await w.svc.cancelOccurrence(w.actor, "2026-10-24");
      assert.deepEqual([...new Set(await dates(w.svc))], ["2026-10-25", "2026-10-26", "2026-10-27"]); // the very next query already excludes it
      await w.svc.cancelOccurrence(w.actor, "2026-10-26");
      await w.svc.cancelOccurrence(w.actor, "2026-10-28");
      const fresh = new ReportAutomationService(tx, { now: () => w.clock.now, sources }); // "server restart": no memory of the earlier instance
      assert.deepEqual([...new Set(await dates(fresh))], ["2026-10-25", "2026-10-27", "2026-10-29"]);
      assert.equal((await tx.reportDelivery.count({ where: { status: "CANCELLED" } })), 3);
      const s = await fresh.scheduled(w.actor);
      assert.deepEqual(s.cancelledUpcoming.map((c) => c.scheduledAt.toISOString()), ["2026-10-24T12:45:00.000Z", "2026-10-26T12:45:00.000Z", "2026-10-28T12:45:00.000Z"]); // 18:15 IST each
      assert.equal(s.cancelledUpcoming.every((c) => c.cancelledBy === "Admin"), true);
      assert.equal(s.recent.filter((r) => r.status === "CANCELLED").length, 3);
      await fresh.runDue(); await w.svc.runDue(); // a scheduler tick changes nothing
      assert.deepEqual([...new Set(await dates(fresh))], ["2026-10-25", "2026-10-27", "2026-10-29"]);
      assert.equal(w.sent.templates.length, 1);
      // cancelling 25 later does not touch 27 or 29
      await fresh.cancelOccurrence(w.actor, "2026-10-25");
      assert.deepEqual([...new Set(await dates(fresh))], ["2026-10-27", "2026-10-29", "2026-10-30"]);
    });
  });
  it("the cancelled occurrence is cancelled even when cancel and the scheduler tick run together", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      w.clock.now = new Date("2026-10-24T12:40:00Z"); // five minutes before 18:15 IST on 24 Oct
      const [c] = await Promise.allSettled([w.svc.cancelOccurrence(w.actor, D24), w.svc.runDue()]);
      assert.equal(c.status, "fulfilled");
      w.clock.now = new Date("2026-10-24T12:50:00Z");
      await w.svc.runDue();
      assert.equal(w.sent.templates.length, 1, "never sent");
      assert.equal((await tx.reportDelivery.findFirstOrThrow({ where: { reportDate: "2026-10-24", kind: "SCHEDULED" } })).status, "CANCELLED");
    });
  });
});
