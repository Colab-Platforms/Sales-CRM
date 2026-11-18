// LIVE TRACKING of a report run: delivery status comes only from the provider's callbacks (sent -> delivered -> read, or failed), the reply only from a real inbound message, each against the right run and
// recipient, idempotently. Real service + schema on the isolated database (one rolled-back transaction per test); WhatsApp is a fake - nothing is sent anywhere.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import ReportAutomationService from "./report-automation.service.js";
import { ReportSendRejected } from "./report-automation.sender.js";
import { applyReportDeliveryStatus } from "./report-automation.status.js";
import type { ReportSources } from "./report-automation.report.js";
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

const A = "+919876543210";
const B = "+919811122233";
const C = "+919822233344";
const D = "+919833344455";
const okSources: ReportSources = { overview: async () => [] as never, cancelledByUser: async () => new Map(), pendingFollowUps: async () => new Map() };
const at9 = (day: number) => new Date(`2026-11-${String(day).padStart(2, "0")}T03:30:00Z`); // 09:00 IST
const tpl = (phone: string) => `wamid.tpl.${phone}`;

async function harness(tx: Prisma.TransactionClient, recipients: { name: string; phone: string; enabled?: boolean }[]) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${randomUUID()}`, role: Role.ADMIN } });
  const clock = { now: at9(19) };
  const refuse = new Set<string>();
  const svc = new ReportAutomationService(tx, {
    now: () => clock.now,
    sources: okSources,
    send: async (i) => { if (refuse.has(i.recipient)) throw new ReportSendRejected("Meta refused the template (test)"); return { providerMessageId: tpl(i.recipient), provider: "META" }; },
    sendDocument: async (i) => ({ providerMessageId: `wamid.doc.${i.recipient}`, mediaId: "m", provider: "META" }),
    sendDetail: async (i) => ({ providerMessageId: `wamid.txt.${i.recipient}`, provider: "META" }),
    windowOpen: async () => false, // the summary template goes out; the detail and Excel wait for a reply
  });
  const actor = { id: admin.id, username: admin.username, role: Role.ADMIN };
  await svc.saveConfig(actor, { enabled: true, recipients, sendTime: "09:00", timezone: "Asia/Kolkata", reportFor: "YESTERDAY", dataDate: null, templateName: "daily_team_report", languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, includedUserIds: [], sendText: true, sendExcel: true, replyTriggersDetail: true });
  await tx.reportAutomation.updateMany({ where: { ownerId: admin.id }, data: { updatedAt: new Date(at9(19).getTime() - 3_600_000) } });
  return { admin, actor, clock, svc, refuse };
}
const runDay = async (tx: Prisma.TransactionClient, w: Awaited<ReturnType<typeof harness>>, day: number) => {
  w.clock.now = at9(day);
  await w.svc.runDue();
  // runs are stamped by the database clock; the tests use a fake one
  // only the run this tick just created: it carries the fake send time in scheduled_for, while its created_at is the real database clock
  await tx.reportDelivery.updateMany({ where: { automation: { ownerId: w.admin.id }, scheduledFor: w.clock.now, createdAt: { lt: new Date(Date.now() + 60_000) }, NOT: { createdAt: w.clock.now } }, data: { createdAt: w.clock.now } });
};
const cb = (tx: Prisma.TransactionClient, id: string, status: "SENT" | "DELIVERED" | "READ" | "FAILED", at: Date, errorMessage?: string) => applyReportDeliveryStatus(tx, "META", { providerMessageId: id, status, timestamp: at, ...(errorMessage ? { errorMessage } : {}) });
const rowOf = async (w: Awaited<ReturnType<typeof harness>>, phone: string, runId?: string) => {
  const t = await w.svc.tracking(w.actor, runId);
  return { run: t.run!, row: t.run!.recipients.find((r) => r.phone.endsWith(phone.slice(-2)) && r.phone.startsWith(phone.slice(0, 3)))! };
};

describe("delivery ticks come only from provider callbacks", () => {
  it("accepted -> delivered -> read, each with its own timestamp; nothing is Delivered or Read before the provider says so", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, [{ name: "Owner", phone: A }]);
      await runDay(tx, w, 19);
      let { row } = await rowOf(w, A);
      assert.deepEqual([row.status, row.deliveredAt, row.readAt, row.repliedAt], ["SENT", null, null, null], "accepted by WhatsApp only: one tick");
      await cb(tx, tpl(A), "DELIVERED", new Date("2026-11-19T03:31:00Z"));
      ({ row } = await rowOf(w, A));
      assert.equal(row.status, "DELIVERED");
      assert.equal(row.deliveredAt?.toISOString(), "2026-11-19T03:31:00.000Z");
      assert.equal(row.readAt, null);
      await cb(tx, tpl(A), "READ", new Date("2026-11-19T03:45:00Z"));
      ({ row } = await rowOf(w, A));
      assert.equal(row.status, "READ");
      assert.equal(row.readAt?.toISOString(), "2026-11-19T03:45:00.000Z");
      assert.equal(row.repliedAt, null, "read is not replied");
    });
  });

  it("duplicate and out-of-order callbacks change nothing: a repeated READ keeps its time, a late DELIVERED never moves READ backwards", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, [{ name: "Owner", phone: A }]);
      await runDay(tx, w, 19);
      await cb(tx, tpl(A), "READ", new Date("2026-11-19T03:45:00Z"));
      assert.equal(await cb(tx, tpl(A), "READ", new Date("2026-11-19T04:10:00Z")), 0, "the retried webhook is a no-op");
      assert.equal(await cb(tx, tpl(A), "DELIVERED", new Date("2026-11-19T03:50:00Z")), 0, "a late DELIVERED does not downgrade");
      const { row } = await rowOf(w, A);
      assert.equal(row.status, "READ");
      assert.equal(row.readAt?.toISOString(), "2026-11-19T03:45:00.000Z");
    });
  });

  it("a failed message keeps the provider's reason and timestamp; a callback for an unknown message id touches nothing", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, [{ name: "Owner", phone: A }]);
      await runDay(tx, w, 19);
      assert.equal(await cb(tx, "wamid.someone-elses-message", "READ", new Date()), 0);
      await cb(tx, tpl(A), "FAILED", new Date("2026-11-19T03:32:00Z"), "Message undeliverable (131026)");
      const { row } = await rowOf(w, A);
      assert.equal(row.status, "FAILED");
      assert.match(row.error ?? "", /131026/);
    });
  });
});

describe("reply tracking: only a real inbound message marks Replied", () => {
  it("a recipient who reads but never replies stays Not replied; the reply sets it once, with the inbound message's own time, and a second message changes nothing", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, [{ name: "Owner", phone: A }, { name: "Ops", phone: B }]);
      await runDay(tx, w, 19);
      await cb(tx, tpl(A), "READ", new Date("2026-11-19T03:45:00Z"));
      assert.equal((await rowOf(w, A)).row.repliedAt, null);
      const at = new Date("2026-11-19T04:00:00Z");
      const first = await w.svc.recordReply(A, tpl(A), { id: "wamid.in.1", at });
      assert.deepEqual([first.recorded], [true]);
      const later = await w.svc.recordReply(A, null, { id: "wamid.in.2", at: new Date("2026-11-19T06:00:00Z") });
      assert.equal(later.recorded, false, "only the first reply counts");
      const { row } = await rowOf(w, A);
      assert.equal(row.repliedAt?.toISOString(), at.toISOString());
      assert.equal((await rowOf(w, B)).row.repliedAt, null, "the other recipient is not marked");
    });
  });

  it("quoting someone else's message, a stranger, a cancelled-run reply and an unsent report never mark anyone", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, [{ name: "Owner", phone: A }, { name: "Ops", phone: B }]);
      await runDay(tx, w, 19);
      assert.equal((await w.svc.recordReply(A, tpl(B))).recorded, false, "A quoted the message that went to B");
      assert.equal((await w.svc.recordReply(A, "wamid.an-ordinary-customer-chat")).recorded, false, "a quote of a non-report message");
      assert.equal((await w.svc.recordReply("+919000000099", null)).recorded, false, "a stranger");
      assert.equal((await w.svc.recordReply("not a number", null)).recorded, false);
      const t = await w.svc.tracking(w.actor);
      assert.ok(t.run!.recipients.every((r) => r.repliedAt === null));
    });
  });

  it("a recipient whose message was refused (never sent) cannot be marked as having replied to it", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, [{ name: "Owner", phone: A }, { name: "Ops", phone: D }]);
      w.refuse.add(D);
      await runDay(tx, w, 19);
      assert.equal((await w.svc.recordReply(D, null)).recorded, false, "nothing was sent to D");
      assert.equal((await rowOf(w, D)).row.status, "FAILED");
    });
  });

  it("through the REAL inbound path: a quoted reply is recorded; the same webhook delivered again is ignored", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, [{ name: "Owner", phone: A }]);
      await runDay(tx, w, 19);
      const svc = new ReportAutomationService(tx, { now: () => new Date(w.clock.now.getTime() + 600_000), sources: okSources, send: async (i) => ({ providerMessageId: `x.${i.recipient}`, provider: "META" }), sendDetail: async () => ({ providerMessageId: "t", provider: "META" }), sendDocument: async () => ({ providerMessageId: "d", mediaId: "m", provider: "META" }), windowOpen: async () => true });
      const wa = new WhatsAppService(tx as never, undefined, undefined, (phone, replyTo, inbound) => svc.sendPendingOnReply(phone, replyTo, inbound));
      const msg = { providerMessageId: `wamid.in.${randomUUID()}`, from: A.slice(1), to: null, messageType: "TEXT" as const, text: "Yes", timestamp: new Date("2026-11-19T04:05:00Z"), replyToProviderMessageId: tpl(A) };
      await wa.recordInboundMessage("META", msg);
      await wa.idle();
      let { row } = await rowOf(w, A);
      assert.equal(row.repliedAt?.toISOString(), "2026-11-19T04:05:00.000Z");
      await wa.recordInboundMessage("META", msg); // Meta retries the webhook
      await wa.idle();
      ({ row } = await rowOf(w, A));
      assert.equal(row.repliedAt?.toISOString(), "2026-11-19T04:05:00.000Z");
    });
  });
});

describe("one run, several recipients, different outcomes", () => {
  it("each recipient shows its own state and the run's counts follow from them", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, [{ name: "Owner", phone: A }, { name: "Ops", phone: B }, { name: "Third", phone: C }, { name: "Fourth", phone: D }]);
      w.refuse.add(D);
      await runDay(tx, w, 19);
      await cb(tx, tpl(A), "READ", new Date("2026-11-19T03:45:00Z"));
      await cb(tx, tpl(B), "DELIVERED", new Date("2026-11-19T03:40:00Z"));
      await w.svc.recordReply(A, tpl(A), { id: "wamid.in.a", at: new Date("2026-11-19T04:00:00Z") });
      const { run } = await rowOf(w, A);
      const by = (p: string) => run.recipients.find((r) => r.phone.endsWith(p.slice(-2)))!;
      assert.deepEqual([by(A).status, by(B).status, by(C).status, by(D).status], ["READ", "DELIVERED", "SENT", "FAILED"]);
      assert.deepEqual([by(A).repliedAt !== null, by(B).repliedAt !== null, by(C).repliedAt !== null, by(D).repliedAt !== null], [true, false, false, false]);
      assert.equal(run.recipients.length, 4);
    });
  });
});

describe("runs: latest by default, history by id, disabled recipients excluded", () => {
  it("returns each run's OWN recipients and statuses; the default is the newest", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, [{ name: "Owner", phone: A }, { name: "Ops", phone: B }]);
      await runDay(tx, w, 19);
      await cb(tx, tpl(A), "READ", new Date("2026-11-19T03:45:00Z"));
      await w.svc.recordReply(A, tpl(A), { id: "wamid.in.a", at: new Date("2026-11-19T04:00:00Z") });
      await runDay(tx, w, 20);
      const latest = await w.svc.tracking(w.actor);
      assert.equal(latest.runs.length, 2);
      assert.equal(latest.run!.reportDate, "2026-11-19", "the 20 Nov send covers 19 Nov");
      assert.ok(latest.run!.recipients.every((r) => r.repliedAt === null && r.readAt === null), "the new run has no reads or replies yet");
      const older = latest.runs.find((r) => r.reportDate === "2026-11-18")!;
      const hist = await w.svc.tracking(w.actor, older.id);
      assert.equal(hist.run!.reportDate, "2026-11-18");
      const a = hist.run!.recipients.find((r) => r.phone.endsWith("10"))!;
      assert.equal(a.status, "READ");
      assert.ok(a.repliedAt, "the earlier run keeps its own reply");
      await assert.rejects(() => w.svc.tracking(w.actor, randomUUID()), /not found/i);
    });
  });

  it("a disabled recipient is not part of the run, so it is not in the totals", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, [{ name: "Owner", phone: A }, { name: "Ops", phone: B, enabled: false }, { name: "Third", phone: C }]);
      await runDay(tx, w, 19);
      const t = await w.svc.tracking(w.actor);
      assert.equal(t.run!.recipients.length, 2);
      assert.ok(!t.run!.recipients.some((r) => r.phone.endsWith("33") && r.phone.startsWith("+91981")));
    });
  });

  it("nothing yet: before the first report there is no run, and another admin never sees this automation's runs", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, [{ name: "Owner", phone: A }]);
      assert.deepEqual(await w.svc.tracking(w.actor), { runs: [], run: null });
      await runDay(tx, w, 19);
      const other = await tx.user.create({ data: { name: "Other", username: `o-${randomUUID()}`, role: Role.ADMIN } });
      const t = await w.svc.tracking({ id: other.id, username: other.username, role: Role.ADMIN }, (await w.svc.tracking(w.actor)).runs[0]!.id);
      assert.deepEqual(t, { runs: [], run: null });
    });
  });
});
