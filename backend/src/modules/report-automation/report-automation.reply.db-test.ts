// "Reply releases the Daily Team Report": while the recipient's 24-hour WhatsApp window is closed the scheduled run sends only the approved template (the short summary) and holds the detailed text and the Excel
// back as "Failed - window closed". When an AUTHORIZED recipient writes any text message to the business number, the CRM sends those two parts, for the held run's report date. Real service + real schema on the
// isolated database (one rolled-back transaction per test); WhatsApp and the report data are fakes - nothing is sent anywhere.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import ReportAutomationService from "./report-automation.service.js";
import { ReportSendRejected, type ReportDocumentInput, type ReportSendInput } from "./report-automation.sender.js";
import { formatDateLabel, type ReportSources } from "./report-automation.report.js";
import WhatsAppService, { drainWhatsAppBackgroundWork } from "../whatsapp/whatsapp.service.js";
import type { NormalizedIncomingMessage } from "../whatsapp/whatsapp.provider.js";

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
const T_1815 = "2026-10-23T12:45:00Z"; // 18:15 IST on 23 Oct 2026
const A = "+919876543210";
const B = "+919811122233";
const STRANGER = "+919000000099";

const people = [
  { id: "t1", name: "Asha", leads: 10, contacted: 8, interested: 4, converted: 2, calls: 30, connected: 20, talkTimeSec: 3600, orders: 2, revenue: 1298 },
  { id: "t2", name: "Bala", leads: 5, contacted: 3, interested: 1, converted: 0, calls: 12, connected: 6, talkTimeSec: 900, orders: 0, revenue: 0 },
];
const okSources: ReportSources = { overview: async () => people as never, cancelledByUser: async () => new Map(), pendingFollowUps: async () => new Map() };

function fakeWhatsApp() {
  const templates: ReportSendInput[] = [];
  const texts: { recipient: string; text: string }[] = [];
  const files: { recipient: string; filename: string; bytes: Buffer; caption: string }[] = [];
  const modes = { text: {} as Record<string, "ok" | "refuse" | "timeout">, doc: {} as Record<string, "ok" | "refuse" | "timeout"> };
  const closed = new Set<string>();
  return {
    templates, texts, files, modes, closed,
    send: async (i: ReportSendInput) => { templates.push(i); return { providerMessageId: `wamid.tpl.${templates.length}`, provider: "META" }; },
    sendDetail: async (i: { recipient: string; text: string }) => {
      const m = modes.text[i.recipient] ?? "ok";
      if (m === "refuse") throw new ReportSendRejected("Meta refused the text");
      if (m === "timeout") throw new Error("socket hang up");
      texts.push(i);
      return { providerMessageId: `wamid.txt.${texts.length}`, provider: "META" };
    },
    sendDocument: async (i: ReportDocumentInput) => {
      const m = modes.doc[i.recipient] ?? "ok";
      if (m === "refuse") throw new ReportSendRejected("Meta refused the file");
      if (m === "timeout") throw new Error("socket hang up");
      files.push({ recipient: i.recipient, filename: i.filename, bytes: i.bytes, caption: i.caption });
      return { providerMessageId: `wamid.doc.${files.length}`, mediaId: i.mediaId ?? `media.${files.length}`, provider: "META" };
    },
    windowOpen: async (phone: string) => !closed.has(phone),
  };
}

const baseConfig = { enabled: true, recipients: [{ name: "Owner", phone: A }, { name: "Ops", phone: B }], sendTime: "18:15", timezone: IST, reportFor: "TODAY" as "TODAY" | "YESTERDAY" | "DATE" | "LAST7DAYS", dataDate: undefined as string | undefined, templateName: "daily_team_report", languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, includedUserIds: [] as string[], sendText: true, sendExcel: true };

/** A scheduled run at 18:15 IST on 23 Oct with BOTH recipients' windows closed: the template goes out, the detailed text and the Excel are held back as FAILED. */
async function held(tx: Prisma.TransactionClient, over: { sources?: ReportSources; sendExcel?: boolean; config?: Record<string, unknown>; start?: string } = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const clock = { now: new Date(over.start ?? T_1815) };
  const wa = fakeWhatsApp();
  wa.closed.add(A).add(B);
  const sources = { current: over.sources ?? okSources };
  const live: ReportSources = {
    overview: (...a: Parameters<ReportSources["overview"]>) => sources.current.overview(...a),
    cancelledByUser: (...a: Parameters<ReportSources["cancelledByUser"]>) => sources.current.cancelledByUser(...a),
    pendingFollowUps: (...a: Parameters<ReportSources["pendingFollowUps"]>) => sources.current.pendingFollowUps(...a),
  };
  const svc = new ReportAutomationService(tx, { now: () => clock.now, sources: live, send: wa.send, sendDocument: wa.sendDocument, sendDetail: wa.sendDetail, windowOpen: wa.windowOpen });
  const config = { enabled: true, recipients: [{ name: "Owner", phone: A }, { name: "Ops", phone: B }], sendTime: "18:15", timezone: IST, reportFor: "TODAY" as const, templateName: "daily_team_report", languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, includedUserIds: [] as string[], sendText: true, sendExcel: over.sendExcel ?? true, ...(over.config ?? {}) } as typeof baseConfig;
  const actor = { id: admin.id, username: admin.username, role: Role.ADMIN };
  await svc.saveConfig(actor, config);
  // settings are stamped by the database clock; a run is only owed for send times at/after the save, so date the save before the fake clock
  await tx.reportAutomation.updateMany({ where: { ownerId: admin.id }, data: { updatedAt: new Date(clock.now.getTime() - 3_600_000) } });
  await svc.runDue();
  // the run row is stamped by the database clock; the test clock is fake, so date the run at the fake send time (in production both are the same clock)
  await tx.reportDelivery.updateMany({ where: { kind: "SCHEDULED", automationId: (await tx.reportAutomation.findUniqueOrThrow({ where: { ownerId: admin.id } })).id }, data: { createdAt: clock.now } });
  const run = await tx.reportDelivery.findFirstOrThrow({ where: { kind: "SCHEDULED" }, include: { recipientResults: true }, orderBy: { createdAt: "desc" } });
  return { admin, actor, clock, wa, svc, sources, config, run, live };
}
const rowOf = (tx: Prisma.TransactionClient, runId: string, phone: string) => tx.reportDeliveryRecipient.findFirstOrThrow({ where: { deliveryId: runId, phone } });
const open = (w: Awaited<ReturnType<typeof held>>, ...phones: string[]) => phones.forEach((p) => w.wa.closed.delete(p));

describe("Daily Team Report - held back while the window is closed", () => {
  it("the scheduled run sends ONLY the approved template while the window is closed; the detailed text and the Excel are held back (Failed, with the reason) - nothing else is sent automatically", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      assert.equal(w.wa.templates.length, 2);
      assert.equal(w.wa.texts.length + w.wa.files.length, 0);
      const a = await rowOf(tx, w.run.id, A);
      assert.deepEqual([a.status, a.txtStatus, a.docStatus], ["SENT", "WAITING_FOR_REPLY", "WAITING_FOR_REPLY"]);
      assert.match(a.txtError ?? "", /24 hours/);
    });
  });
});

describe("reply releases the held report", () => {
  it("an authorized recipient replies: the FULL detailed text (team overview + telecaller-wise breakdown) and a VALID Excel for the run's report date are sent; the template is not sent again; each part is recorded SENT", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A); // her message opens the window
      const o = await w.svc.sendPendingOnReply(A);
      assert.equal(o.handled, true);
      assert.equal(o.reportDate, "2026-10-23");
      assert.deepEqual(o.parts, { detail: "SENT", excel: "SENT" });
      assert.equal(w.wa.templates.length, 2, "no second template");
      // the detailed text: the real report, not the short template line
      const text = w.wa.texts.find((t) => t.recipient === A)!.text;
      assert.match(text, new RegExp(formatDateLabel("2026-10-23")));
      assert.match(text, /Asha/);
      assert.match(text, /Bala/);
      assert.ok(text.length > w.wa.templates[0]!.text.length, "longer than the abbreviated template text");
      assert.equal(w.wa.texts.some((t) => t.recipient === B), false, "the other recipient is untouched");
      // the Excel: a real workbook with the telecaller rows
      const f = w.wa.files.find((x) => x.recipient === A)!;
      assert.equal(f.filename, "AyushWellness_Daily_Report_2026-10-23.xlsx");
      assert.match(f.caption, /Daily Team Report/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(f.bytes as never);
      const cells = wb.worksheets.flatMap((s) => { const out: string[] = []; s.eachRow((r) => r.eachCell((c) => out.push(String(c.value ?? "")))); return out; });
      assert.ok(wb.worksheets.length >= 1);
      assert.ok(cells.some((c) => c.includes("Asha")) && cells.some((c) => c.includes("Bala")), "telecaller rows are in the workbook");
      const a = await rowOf(tx, w.run.id, A);
      assert.deepEqual([a.status, a.txtStatus, a.docStatus], ["SENT", "SENT", "SENT"]);
      assert.equal((await tx.reportDelivery.findUniqueOrThrow({ where: { id: w.run.id } })).status, "PENDING", "the run summary stays open: B, whose window is closed, is still waiting for a reply");
    });
  });

  it("ANY reply text works (the trigger is the message arriving, not its content) and the number may arrive in any format (wa_id without +, spaces)", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      const o = await w.svc.sendPendingOnReply("91 98765 43210");
      assert.equal(o.handled, true);
      assert.equal(w.wa.texts.length, 1);
    });
  });

  it("an UNAUTHORIZED sender gets nothing: not a recipient, a recipient removed after the run, or the automation switched off - no send, no hint", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A, B, STRANGER);
      const stranger = await w.svc.sendPendingOnReply(STRANGER);
      assert.deepEqual([stranger.handled, w.wa.texts.length, w.wa.files.length], [false, 0, 0]);
      assert.equal((await w.svc.sendPendingOnReply("not a number")).handled, false);
      // removed from the list after the run -> no longer authorized
      await w.svc.saveConfig(w.actor, { ...w.config, recipients: [{ name: "Ops", phone: B }] });
      assert.equal((await w.svc.sendPendingOnReply(A)).handled, false);
      assert.equal(w.wa.texts.some((t) => t.recipient === A), false);
      // switched off -> nobody receives anything on a reply
      await w.svc.saveConfig(w.actor, { ...w.config, enabled: false });
      assert.equal((await w.svc.sendPendingOnReply(B)).handled, false);
      assert.equal(w.wa.texts.length + w.wa.files.length, 0);
    });
  });

  it("an owner who is no longer an active Admin / Manager cannot have the report generated", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      await tx.user.update({ where: { id: w.admin.id }, data: { status: "INACTIVE" } });
      const o = await w.svc.sendPendingOnReply(A);
      assert.equal(o.handled, false);
      assert.match(o.reason, /no longer an active Admin or Manager/);
      assert.equal(w.wa.texts.length, 0);
    });
  });

  it("IDEMPOTENT: a second reply, and two replies at the same instant, send each part exactly once", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      const both = await Promise.all([w.svc.sendPendingOnReply(A), w.svc.sendPendingOnReply(A)]);
      assert.equal(both.filter((o) => o.handled).length, 1);
      assert.equal(w.wa.texts.filter((t) => t.recipient === A).length, 1);
      assert.equal(w.wa.files.filter((f) => f.recipient === A).length, 1);
      const again = await w.svc.sendPendingOnReply(A);
      assert.equal(again.handled, false);
      assert.match(again.reason, /nothing left|no held-back/);
      assert.equal(w.wa.texts.length + w.wa.files.length, 2);
    });
  });

  it("the report is the held run's date in Asia/Kolkata even when the reply comes the next morning, and a run older than 48 hours is not released", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      w.clock.now = new Date("2026-10-24T02:00:00Z"); // 07:30 IST on 24 Oct
      const o = await w.svc.sendPendingOnReply(A);
      assert.equal(o.reportDate, "2026-10-23", "the 23rd's report, not the 24th");
      assert.equal(w.wa.files[0]!.filename, "AyushWellness_Daily_Report_2026-10-23.xlsx");
    });
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      w.clock.now = new Date("2026-10-26T12:45:00Z"); // 3 days later
      assert.equal((await w.svc.sendPendingOnReply(A)).handled, false);
      assert.equal(w.wa.texts.length, 0);
    });
  });

  it("a Sent-only-Excel configuration (text switched off) releases just the Excel; a part that is SKIPPED is never sent", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const wa = fakeWhatsApp();
      wa.closed.add(A);
      const clock = { now: new Date(T_1815) };
      const svc = new ReportAutomationService(tx, { now: () => clock.now, sources: okSources, send: wa.send, sendDocument: wa.sendDocument, sendDetail: wa.sendDetail, windowOpen: wa.windowOpen });
      const actor = { id: admin.id, username: admin.username, role: Role.ADMIN };
      await svc.saveConfig(actor, { enabled: true, recipients: [{ name: "Owner", phone: A }], sendTime: "18:15", timezone: IST, reportFor: "TODAY", templateName: "daily_team_report", languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, includedUserIds: [], sendText: false, sendExcel: true });
      await svc.runDue();
      wa.closed.delete(A);
      const o = await svc.sendPendingOnReply(A);
      assert.deepEqual(o.parts, { excel: "SENT" });
      assert.equal(wa.texts.length, 0);
    });
  });
});

describe("reply - provider and generation failures are safe to retry", () => {
  it("the provider refuses the text (definite): that part stays FAILED with the reason while the Excel is still sent; the NEXT reply retries only the text", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      w.wa.modes.text[A] = "refuse";
      const first = await w.svc.sendPendingOnReply(A);
      assert.deepEqual(first.parts, { detail: "FAILED", excel: "SENT" });
      assert.match((await rowOf(tx, w.run.id, A)).txtError ?? "", /Meta refused the text/);
      w.wa.modes.text[A] = "ok";
      const second = await w.svc.sendPendingOnReply(A);
      assert.deepEqual(second.parts, { detail: "SENT" }, "only the failed part is retried");
      assert.equal(w.wa.files.filter((f) => f.recipient === A).length, 1, "the Excel is not sent twice");
    });
  });

  it("no answer from the provider (timeout) is UNCERTAIN and is never re-sent on a later reply; the Excel failing does not stop the text", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      w.wa.modes.doc[A] = "timeout";
      const first = await w.svc.sendPendingOnReply(A);
      assert.deepEqual(first.parts, { detail: "SENT", excel: "UNCERTAIN" });
      w.wa.modes.doc[A] = "ok";
      const second = await w.svc.sendPendingOnReply(A);
      assert.equal(second.handled, false);
      assert.equal(w.wa.files.length, 0, "an unknown outcome is not sent again automatically");
    });
  });

  it("report generation fails (database error): nothing is sent, both parts are FAILED with a clear reason, and the next reply succeeds", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      const broken: ReportSources = { overview: async () => { throw new Error("connection terminated"); }, cancelledByUser: async () => new Map(), pendingFollowUps: async () => new Map() };
      w.sources.current = broken;
      const first = await w.svc.sendPendingOnReply(A);
      assert.deepEqual(first.parts, { detail: "FAILED", excel: "FAILED" });
      assert.equal(w.wa.texts.length + w.wa.files.length, 0);
      assert.match((await rowOf(tx, w.run.id, A)).txtError ?? "", /could not be generated/);
      w.sources.current = okSources;
      const second = await w.svc.sendPendingOnReply(A);
      assert.deepEqual(second.parts, { detail: "SENT", excel: "SENT" });
    });
  });

  it("the window is still closed when the reply is processed: nothing is sent, the parts fail again with the window reason (attempt counted) and the next reply tries again", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      const o = await w.svc.sendPendingOnReply(A); // window not opened
      assert.deepEqual(o.parts, { detail: "WAITING_FOR_REPLY", excel: "WAITING_FOR_REPLY" });
      assert.equal(w.wa.texts.length + w.wa.files.length, 0);
      assert.equal((await rowOf(tx, w.run.id, A)).txtAttempts, 2);
      open(w, A);
      assert.deepEqual((await w.svc.sendPendingOnReply(A)).parts, { detail: "SENT", excel: "SENT" });
    });
  });
});

describe("the real inbound path (WhatsAppService.recordInboundMessage)", () => {
  const msg = (over: Partial<NormalizedIncomingMessage> & { providerMessageId: string; from: string }): NormalizedIncomingMessage => ({ to: null, messageType: "TEXT", text: "Hi", timestamp: new Date(), ...over });

  it("a META text message from a recipient stores the inbound message (opening the window) and then releases the held report; a repeated webhook delivery does not send again; media / other providers do not trigger it", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      // no windowOpen override: the window is decided from the inbound message the CRM has just stored
      const svc = new ReportAutomationService(tx, { now: () => new Date(), sources: okSources, send: w.wa.send, sendDocument: w.wa.sendDocument, sendDetail: w.wa.sendDetail });
      const wa = new WhatsAppService(tx as never, undefined, undefined, (phone) => svc.sendPendingOnReply(phone));
      // the run is "now" for this service: re-date it so the 48-hour look-back includes it
      await tx.reportDelivery.update({ where: { id: w.run.id }, data: { createdAt: new Date() } });
      const id = `wamid.in.${uid()}`;
      await wa.recordInboundMessage("META", msg({ providerMessageId: id, from: A.slice(1), text: "ok thanks" }));
      await wa.idle();
      assert.equal(w.wa.texts.filter((t) => t.recipient === A).length, 1);
      assert.equal(w.wa.files.filter((f) => f.recipient === A).length, 1);
      // the same webhook delivered again (Meta retries): nothing new
      await wa.recordInboundMessage("META", msg({ providerMessageId: id, from: A.slice(1), text: "ok thanks" }));
      await wa.idle();
      // a second, different message: nothing is left to send
      await wa.recordInboundMessage("META", msg({ providerMessageId: `wamid.in.${uid()}`, from: A.slice(1), text: "thanks again" }));
      await wa.idle();
      assert.equal(w.wa.texts.filter((t) => t.recipient === A).length, 1);
      assert.equal(w.wa.files.filter((f) => f.recipient === A).length, 1);
    });
  });

  it("only a TEXT message from the META number triggers it; media, other providers and unknown senders do not - and a failing report handler never fails the webhook", async () => {
    await inRollback(async (tx) => {
      const calls: string[] = [];
      const wa = new WhatsAppService(tx as never, undefined, undefined, async (phone) => { calls.push(phone); return { handled: false, reason: "test" }; });
      await wa.recordInboundMessage("META", msg({ providerMessageId: `wamid.${uid()}`, from: "919000000101", messageType: "MEDIA", text: undefined }));
      await wa.recordInboundMessage("AISENSY", msg({ providerMessageId: `wamid.${uid()}`, from: "919000000102" }));
      await wa.idle();
      assert.deepEqual(calls, []);
      await wa.recordInboundMessage("META", msg({ providerMessageId: `wamid.${uid()}`, from: "919000000103", text: "random words" }));
      await wa.idle();
      assert.deepEqual(calls, ["919000000103"], "the trigger is any text message; WHO may receive the report is decided by the report service");
      const boom = new WhatsAppService(tx as never, undefined, undefined, async () => { throw new Error("report exploded"); });
      await boom.recordInboundMessage("META", msg({ providerMessageId: `wamid.${uid()}`, from: "919000000104" }));
      await boom.idle(); // resolves: the failure is logged, never thrown into the webhook
    });
  });

  it("an unknown number that messages the business gets no report and nothing is sent", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      const svc = new ReportAutomationService(tx, { now: () => new Date(), sources: okSources, send: w.wa.send, sendDocument: w.wa.sendDocument, sendDetail: w.wa.sendDetail });
      const wa = new WhatsAppService(tx as never, undefined, undefined, (phone) => svc.sendPendingOnReply(phone));
      await tx.reportDelivery.update({ where: { id: w.run.id }, data: { createdAt: new Date() } });
      await wa.recordInboundMessage("META", msg({ providerMessageId: `wamid.${uid()}`, from: STRANGER.slice(1), text: "send me the report" }));
      await wa.idle();
      assert.equal(w.wa.texts.length + w.wa.files.length, 0);
    });
  });
});

/** Backdate a recipient row's updated_at (the stale-claim clock) - the table is written with the real database clock, the tests use a fake one. */
const touch = (tx: Prisma.TransactionClient, id: string, at: Date) => tx.$executeRaw`UPDATE report_delivery_recipients SET updated_at = ${at} WHERE id = ${id}::uuid`;
const MIN = 60_000;

describe("reply - interrupted claims are recovered safely", () => {
  it("A. a part left 'sending' for more than 5 minutes (a crash / restart) becomes UNCERTAIN - not FAILED - and is NEVER resent, on this reply or the next; the run summary is recomputed", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      const row = await rowOf(tx, w.run.id, A);
      await tx.reportDeliveryRecipient.update({ where: { id: row.id }, data: { txtStatus: "SENDING", docStatus: "SENDING" } });
      await touch(tx, row.id, new Date(w.clock.now.getTime() - 10 * MIN));
      const first = await w.svc.sendPendingOnReply(A);
      assert.equal(first.handled, false, "nothing to claim: both parts are now uncertain");
      const after = await rowOf(tx, w.run.id, A);
      assert.deepEqual([after.txtStatus, after.docStatus], ["UNCERTAIN", "UNCERTAIN"]);
      assert.match(after.txtError ?? "", /interrupted .* may have been delivered/);
      assert.equal(w.wa.texts.length + w.wa.files.length, 0, "not resent");
      assert.notEqual((await tx.reportDelivery.findUniqueOrThrow({ where: { id: w.run.id } })).status, "SENDING");
      assert.equal((await w.svc.sendPendingOnReply(A)).handled, false, "still not resent on the next reply");
      assert.equal(w.wa.texts.length + w.wa.files.length, 0);
    });
  });

  it("A. recovery is conditional: a FRESH 'sending' part (another worker is on it) is left alone while the other part is released; a finished part is never touched", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      const row = await rowOf(tx, w.run.id, A);
      await tx.reportDeliveryRecipient.update({ where: { id: row.id }, data: { docStatus: "SENDING" } });
      await touch(tx, row.id, new Date(w.clock.now.getTime() - 1 * MIN)); // 1 minute: another worker's live claim
      const o = await w.svc.sendPendingOnReply(A);
      assert.deepEqual(o.parts, { detail: "SENT" }, "the text is released, the Excel (claimed by someone else) is not touched");
      const mid = await rowOf(tx, w.run.id, A);
      assert.equal(mid.docStatus, "SENDING");
      assert.equal(w.wa.files.length, 0);
      // a SENT part with an old timestamp is not 'recovered'
      await touch(tx, row.id, new Date(w.clock.now.getTime() - 30 * MIN));
      await w.svc.sendPendingOnReply(A);
      assert.equal((await rowOf(tx, w.run.id, A)).txtStatus, "SENT");
    });
  });

  it("A. a concurrent worker finishes the part between the stale check and the update: the conditional update changes nothing, so SENT is preserved", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      const row = await rowOf(tx, w.run.id, A);
      await tx.reportDeliveryRecipient.update({ where: { id: row.id }, data: { txtStatus: "SENDING", docStatus: "SENT" } });
      await touch(tx, row.id, new Date(w.clock.now.getTime() - 10 * MIN));
      let raced = false;
      const racing = new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== "reportDeliveryRecipient") return value;
          return new Proxy(value as object, {
            get(t, p) {
              const f = Reflect.get(t, p) as (...a: unknown[]) => unknown;
              if (p !== "updateMany") return typeof f === "function" ? f.bind(t) : f;
              return async (args: { data?: { txtStatus?: string } }) => {
                if (!raced && args.data?.txtStatus === "UNCERTAIN") {
                  raced = true;
                  await (t as typeof tx.reportDeliveryRecipient).update({ where: { id: row.id }, data: { txtStatus: "SENT", txtAttempts: { increment: 1 } } }); // the other worker finishes first
                }
                return f.call(t, args);
              };
            },
          });
        },
      }) as typeof tx;
      const svc = new ReportAutomationService(racing, { now: () => w.clock.now, sources: okSources, send: w.wa.send, sendDocument: w.wa.sendDocument, sendDetail: w.wa.sendDetail, windowOpen: w.wa.windowOpen });
      await svc.sendPendingOnReply(A);
      assert.equal(raced, true);
      assert.equal((await rowOf(tx, w.run.id, A)).txtStatus, "SENT", "the concurrent worker's result was not overwritten");
    });
  });

  it("B. an unexpected exception after the parts were claimed leaves NOTHING 'sending': both parts become UNCERTAIN, the error is rethrown (for the log), and a later reply does not resend them", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      // the database fails inside deliver() (the lookup of the run's parts) - outside every per-part try/catch
      const failing = new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== "reportDeliveryRecipient") return value;
          return new Proxy(value as object, {
            get(t, p) {
              const f = Reflect.get(t, p) as (...a: unknown[]) => unknown;
              if (p !== "findMany") return typeof f === "function" ? f.bind(t) : f;
              return async (args: { where?: { deliveryId?: string } }) => {
                if (args?.where?.deliveryId) throw new Error("connection terminated unexpectedly");
                return f.call(t, args);
              };
            },
          });
        },
      }) as typeof tx;
      const broken = new ReportAutomationService(failing, { now: () => w.clock.now, sources: okSources, send: w.wa.send, sendDocument: w.wa.sendDocument, sendDetail: w.wa.sendDetail, windowOpen: w.wa.windowOpen });
      await assert.rejects(broken.sendPendingOnReply(A), /connection terminated unexpectedly/);
      const row = await rowOf(tx, w.run.id, A);
      assert.deepEqual([row.txtStatus, row.docStatus], ["UNCERTAIN", "UNCERTAIN"]);
      assert.match(row.docError ?? "", /unexpected error .* may have been delivered/);
      assert.equal(w.wa.texts.length + w.wa.files.length, 0);
      assert.equal((await w.svc.sendPendingOnReply(A)).handled, false, "never retried blindly");
      assert.equal(w.wa.texts.length + w.wa.files.length, 0);
    });
  });
});

describe("reply - the 27 Oct production scenario", () => {
  const msg = (over: Partial<NormalizedIncomingMessage> & { providerMessageId: string; from: string }): NormalizedIncomingMessage => ({ to: null, messageType: "TEXT", text: "Okiee", timestamp: new Date(), ...over });

  it("a 10:38 run for a fixed DATE (26 Oct) is held back with the window closed; the recipient's plain text 'Okiee' arrives through the real inbound path and releases THAT report + Excel (attempt 2), no new run and no second template", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx, { start: "2026-10-27T05:08:30Z", config: { reportFor: "DATE", dataDate: "2026-10-26", sendTime: "10:38", templateName: "daily_team_report1" } }); // 10:38:30 IST on 27 Oct
      const held1 = await rowOf(tx, w.run.id, A);
      assert.deepEqual([held1.txtStatus, held1.txtAttempts, held1.docStatus, held1.docAttempts], ["WAITING_FOR_REPLY", 1, "WAITING_FOR_REPLY", 1]);
      assert.equal(w.run.reportDate, "2026-10-26");
      const runsBefore = await tx.reportDelivery.count();
      const templatesBefore = w.wa.templates.length;
      const svc = new ReportAutomationService(tx, { now: () => new Date(), sources: okSources, send: w.wa.send, sendDocument: w.wa.sendDocument, sendDetail: w.wa.sendDetail });
      await tx.reportDelivery.update({ where: { id: w.run.id }, data: { createdAt: new Date() } });
      const wa = new WhatsAppService(tx as never, undefined, undefined, (phone) => svc.sendPendingOnReply(phone));
      await wa.recordInboundMessage("META", msg({ providerMessageId: `wamid.okiee.${uid()}`, from: A.slice(1) }));
      await wa.idle();
      const released = await rowOf(tx, w.run.id, A);
      assert.deepEqual([released.txtStatus, released.txtAttempts, released.docStatus, released.docAttempts], ["SENT", 2, "SENT", 2]);
      assert.equal(w.wa.files[0]!.filename, "AyushWellness_Daily_Report_2026-10-26.xlsx");
      assert.equal(await tx.reportDelivery.count(), runsBefore, "no new run");
      assert.equal(w.wa.templates.length, templatesBefore, "no second template");
    });
  });

  it("shutdown: drainWhatsAppBackgroundWork waits for a report release that is still running", async () => {
    await inRollback(async (tx) => {
      let finished = false;
      const wa = new WhatsAppService(tx as never, undefined, undefined, async () => { await new Promise((r) => setTimeout(r, 60)); finished = true; return { handled: true, reason: "test" }; });
      await wa.recordInboundMessage("META", msg({ providerMessageId: `wamid.drain.${uid()}`, from: "919000000555" }));
      assert.equal(finished, false, "the webhook path returned without waiting for the report work");
      await drainWhatsAppBackgroundWork();
      assert.equal(finished, true, "shutdown waits for it");
    });
  });
});

describe("WAITING_FOR_REPLY - the durable waiting state", () => {
  it("a closed window leaves both parts WAITING_FOR_REPLY (not Failed), the run open (PENDING), with the reason kept; a restart (new service instance) still sees and releases them", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      const r = await rowOf(tx, w.run.id, A);
      assert.deepEqual([r.txtStatus, r.docStatus, r.txtAttempts, r.docAttempts, w.run.status], ["WAITING_FOR_REPLY", "WAITING_FOR_REPLY", 1, 1, "PENDING"]);
      assert.match(r.txtError ?? "", /24 hours/);
      assert.ok(r.txtLastAttemptAt, "the attempt time is kept");
      open(w, A);
      const restarted = new ReportAutomationService(tx, { now: () => w.clock.now, sources: okSources, send: w.wa.send, sendDocument: w.wa.sendDocument, sendDetail: w.wa.sendDetail, windowOpen: w.wa.windowOpen });
      const runsBefore = await tx.reportDelivery.count();
      const templatesBefore = w.wa.templates.length;
      const out = await restarted.sendPendingOnReply(A);
      assert.equal(out.handled, true);
      const after = await rowOf(tx, w.run.id, A);
      assert.deepEqual([after.txtStatus, after.docStatus, after.txtAttempts, after.docAttempts], ["SENT", "SENT", 2, 2]);
      assert.equal(await tx.reportDelivery.count(), runsBefore, "no new run");
      assert.equal(w.wa.templates.length, templatesBefore, "no second template");
    });
  });

  it("a reply while the window is STILL closed (check at send time) leaves the parts waiting and sends nothing", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      const sentBefore = w.wa.templates.length;
      await w.svc.sendPendingOnReply(A);
      const r = await rowOf(tx, w.run.id, A);
      assert.deepEqual([r.txtStatus, r.docStatus], ["WAITING_FOR_REPLY", "WAITING_FOR_REPLY"]);
      assert.equal(w.wa.templates.length, sentBefore);
    });
  });

  it("parts that waited longer than 48 hours expire to FAILED (manual Retry) on the next scheduler tick; a part released meanwhile is untouched; nothing is sent", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      await w.svc.sendPendingOnReply(A); // A released -> SENT
      w.clock.now = new Date(w.clock.now.getTime() + 49 * 3600_000);
      await tx.reportAutomation.updateMany({ where: { ownerId: w.admin.id }, data: { enabled: false } }); // so the tick only expires (a new day's occurrence would create its own run)
      await w.svc.runDue();
      const a = await rowOf(tx, w.run.id, A);
      const b = await rowOf(tx, w.run.id, B);
      assert.deepEqual([a.txtStatus, a.docStatus], ["SENT", "SENT"]);
      assert.deepEqual([b.txtStatus, b.docStatus], ["FAILED", "FAILED"]);
      assert.match(b.txtError ?? "", /No reply was received within 48 hours/);
      const out = await w.svc.sendPendingOnReply(B);
      assert.equal(out.handled, false, "an expired report is not released by a late reply");
    });
  });

  it("one recipient's reply releases only their own parts; the other recipient keeps waiting", async () => {
    await inRollback(async (tx) => {
      const w = await held(tx);
      open(w, A);
      await w.svc.sendPendingOnReply(A);
      const b = await rowOf(tx, w.run.id, B);
      assert.deepEqual([b.txtStatus, b.docStatus], ["WAITING_FOR_REPLY", "WAITING_FOR_REPLY"]);
    });
  });
});
