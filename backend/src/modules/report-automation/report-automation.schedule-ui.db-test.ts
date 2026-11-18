// What the redesigned Report Automation page relies on: the recurring T-1 date, pause / resume, per-recipient enable, and the grouped, filterable history. Real service + schema on the isolated database
// (one rolled-back transaction per test); WhatsApp and the report data are fakes - nothing is sent anywhere.
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
const B = "+919811122233";
const C = "+919822233344";
const okSources: ReportSources = { overview: async () => [] as never, cancelledByUser: async () => new Map(), pendingFollowUps: async () => new Map() };
const at9 = (day: number) => new Date(`2026-11-${String(day).padStart(2, "0")}T03:30:00Z`); // 09:00 IST

async function harness(tx: Prisma.TransactionClient, start: Date, recipients = [{ name: "Owner", phone: A }, { name: "Ops", phone: B }] as { name: string; phone: string; enabled?: boolean }[]) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${randomUUID()}`, role: Role.ADMIN } });
  const clock = { now: start };
  const sent: ReportSendInput[] = [];
  const svc = new ReportAutomationService(tx, {
    now: () => clock.now,
    sources: okSources,
    send: async (i) => { sent.push(i); return { providerMessageId: `wamid.${sent.length}`, provider: "META" }; },
    sendDocument: async (i: ReportDocumentInput) => ({ providerMessageId: `doc.${i.recipient}`, mediaId: "m", provider: "META" }),
    sendDetail: async () => ({ providerMessageId: "txt", provider: "META" }),
    windowOpen: async () => false,
  });
  const actor = { id: admin.id, username: admin.username, role: Role.ADMIN };
  const config = { enabled: true, recipients, sendTime: "09:00", timezone: "Asia/Kolkata", reportFor: "YESTERDAY" as const, dataDate: null, templateName: "daily_team_report", languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, includedUserIds: [] as string[], sendText: true, sendExcel: true, replyTriggersDetail: true };
  await svc.saveConfig(actor, config);
  // settings take effect when saved: date the save well before the first send so the 09:00 of the first day is owed
  await tx.reportAutomation.updateMany({ where: { ownerId: admin.id }, data: { updatedAt: new Date(start.getTime() - 3_600_000) } });
  return { admin, actor, clock, svc, sent, config };
}
const runsOf = (tx: Prisma.TransactionClient, ownerId: string) => tx.reportDelivery.findMany({ where: { automation: { ownerId } }, orderBy: { reportDate: "asc" }, include: { recipientResults: true } });

describe("recurring daily report: data date = send date - 1 (Asia/Kolkata)", () => {
  it("19 Nov 09:00 sends 18 Nov, 20 Nov sends 19 Nov, 21 Nov sends 20 Nov, 22 Nov sends 21 Nov - the old saved date is never reused", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, at9(19));
      for (const day of [19, 20, 21, 22]) {
        w.clock.now = at9(day);
        await w.svc.runDue();
      }
      const runs = await runsOf(tx, w.admin.id);
      assert.deepEqual(runs.map((r) => r.reportDate), ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"]);
      assert.ok(runs.every((r) => r.recipientResults.length === 2), "every run reaches both recipients");
      assert.equal(w.sent.length, 8);
      // a second tick on the same morning changes nothing
      await w.svc.runDue();
      assert.equal((await runsOf(tx, w.admin.id)).length, 4);
    });
  });

  it("a stale fixed DATE saved earlier does not override the recurring T-1 once the admin switches to Previous day", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, at9(19));
      await w.svc.saveConfig(w.actor, { ...w.config, reportFor: "DATE", dataDate: "2026-11-01" });
      await w.svc.saveConfig(w.actor, { ...w.config, reportFor: "YESTERDAY", dataDate: null });
      await tx.reportAutomation.updateMany({ where: { ownerId: w.admin.id }, data: { updatedAt: new Date(at9(19).getTime() - 3_600_000) } });
      await w.svc.runDue();
      assert.equal((await runsOf(tx, w.admin.id))[0]!.reportDate, "2026-11-18");
      assert.equal((await tx.reportAutomation.findFirstOrThrow({ where: { ownerId: w.admin.id } })).reportDataDate, null);
    });
  });

  it("the upcoming occurrence reports its own data date and moves with the saved time; after today's time has passed the next one is tomorrow", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, new Date("2026-11-18T08:00:00Z")); // 13:30 IST on 18 Nov
      const s = await w.svc.scheduled(w.actor);
      const first = s.upcoming[0]!;
      assert.equal(first.occurrenceDate, "2026-11-19");
      assert.equal(first.dataTo, "2026-11-18");
      assert.equal(new Set(s.upcoming.map((u) => u.occurrenceDate)).size, 3, "three upcoming days, each one row per recipient");
      await w.svc.saveConfig(w.actor, { ...w.config, sendTime: "21:00" });
      const later = (await w.svc.scheduled(w.actor)).upcoming[0]!;
      assert.equal(later.occurrenceDate, "2026-11-18", "21:00 has not passed yet today");
      assert.equal(later.dataTo, "2026-11-17");
    });
  });
});

describe("pause and resume", () => {
  it("while paused nothing is created; resuming later the same morning does not send the missed 09:00; the next day sends yesterday's data", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, at9(19));
      await w.svc.setEnabled(w.actor, false);
      w.clock.now = at9(19);
      await w.svc.runDue();
      assert.equal((await runsOf(tx, w.admin.id)).length, 0, "paused: no run");
      w.clock.now = new Date("2026-11-19T04:30:00Z"); // 10:00 IST
      await w.svc.setEnabled(w.actor, true);
      await w.svc.runDue();
      assert.equal((await runsOf(tx, w.admin.id)).length, 0, "the 09:00 that passed while paused is not sent late");
      w.clock.now = at9(20);
      await w.svc.runDue();
      const runs = await runsOf(tx, w.admin.id);
      assert.deepEqual(runs.map((r) => r.reportDate), ["2026-11-19"]);
    });
  });
});

describe("recipients can be enabled / disabled without being deleted", () => {
  it("a disabled recipient is kept on the list but gets nothing, and cannot release a report by replying", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, at9(19), [{ name: "Owner", phone: A }, { name: "Ops", phone: B, enabled: false }, { name: "Third", phone: C }]);
      const cfg = await w.svc.getConfig(w.actor);
      assert.deepEqual(cfg.recipients.map((r) => [r.phone, r.enabled]), [[A, true], [B, false], [C, true]]);
      await w.svc.runDue();
      const [run] = await runsOf(tx, w.admin.id);
      assert.deepEqual(run!.recipientResults.map((r) => r.phone).sort(), [A, C].sort());
      assert.equal((await w.svc.sendPendingOnReply(B)).handled, false, "a disabled number's reply releases nothing");
      // turning it back on brings it into the next run
      await w.svc.saveConfig(w.actor, { ...w.config, recipients: [{ name: "Owner", phone: A }, { name: "Ops", phone: B, enabled: true }, { name: "Third", phone: C }] });
      await tx.reportAutomation.updateMany({ where: { ownerId: w.admin.id }, data: { updatedAt: new Date(at9(19).getTime()) } });
      w.clock.now = at9(20);
      await w.svc.runDue();
      const runs = await runsOf(tx, w.admin.id);
      assert.deepEqual(runs[1]!.recipientResults.map((r) => r.phone).sort(), [A, B, C].sort());
    });
  });

  it("the automation cannot be turned on when every recipient is disabled", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, at9(19));
      await w.svc.saveConfig(w.actor, { ...w.config, enabled: false, recipients: [{ name: "Owner", phone: A, enabled: false }] });
      await assert.rejects(() => w.svc.setEnabled(w.actor, true), /enable at least one recipient/);
    });
  });
});

describe("history: one entry per run, filterable and paginated", () => {
  it("groups the recipients under ONE run, newest first, 10 per page, and filters by status and by date", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, at9(10));
      for (let day = 10; day <= 22; day++) {
        w.clock.now = at9(day);
        await w.svc.runDue();
      }
      const page1 = await w.svc.history(w.actor, 1, 10);
      assert.equal(page1.pagination.totalItems, 13);
      assert.equal(page1.items.length, 10);
      assert.equal(page1.items[0]!.reportDate, "2026-11-21", "newest first");
      assert.ok(page1.items.every((r) => r.recipients.length === 2), "both recipients are inside the one run");
      assert.equal((await w.svc.history(w.actor, 2, 10)).items.length, 3);
      const byDate = await w.svc.history(w.actor, 1, 10, { date: "2026-11-15" });
      assert.ok(byDate.items.some((r) => r.reportDate === "2026-11-15"));
      assert.equal((await w.svc.history(w.actor, 1, 10, { status: "CANCELLED" })).items.length, 0);
      await tx.reportDelivery.updateMany({ where: { automation: { ownerId: w.admin.id } }, data: { status: "SENT" } });
      await tx.reportDelivery.updateMany({ where: { automation: { ownerId: w.admin.id }, reportDate: "2026-11-12" }, data: { status: "FAILED" } });
      assert.deepEqual((await w.svc.history(w.actor, 1, 10, { status: "FAILED" })).items.map((r) => r.reportDate), ["2026-11-12"]);
      assert.equal((await w.svc.history(w.actor, 1, 10, { status: "SENT" })).pagination.totalItems, 12);
    });
  });
});
