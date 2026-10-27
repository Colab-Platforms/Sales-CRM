// END-TO-END scheduling test: the REAL router (normal JWT auth), the REAL scheduler timer (startReportAutomationScheduler, 60 s tick), the REAL service, sender, Meta provider, template lookup, 24-hour-window
// check, report builder and Excel builder, against the ISOLATED test database, in REAL time. Nothing here calls report generation or sending directly: settings are saved through PUT /config, the run is
// created by the scheduler when the saved time arrives. The ONLY fake is the network: globalThis.fetch is replaced so Meta's Graph API is a recorder (any other outside address throws), so no WhatsApp
// message can leave this machine. The send time and timezone are derived from the clock at run time (a few minutes ahead) - no production time is hard-coded. Takes about 6 minutes.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";

if (!/127\.0\.0\.1:5544\/crm_iso$/.test(process.env.DATABASE_URL ?? "")) throw new Error("GUARD: this test only runs against the isolated database");
process.env.INTEGRATION_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64"); // throwaway key for the throwaway test credentials
process.env.REPORT_CRON_SECRET = "e2e-cron-secret-not-real";
delete process.env.DISABLE_BACKGROUND_JOBS;

const { prisma } = await import("../../lib/prisma.js");
const { signToken } = await import("../../lib/jwt.js");
const { default: routes } = await import("../../routes.js");
const { errorHandler } = await import("../../middlewares/errorHandler.js");
const { encryptJson } = await import("../../utils/crypto.js");
const { startReportAutomationScheduler } = await import("./report-automation.scheduler.js");
const { localParts, localInstant, shiftDate } = await import("./report-automation.report.js");

const TZ = "Pacific/Auckland"; // deliberately not Kolkata: proves the saved timezone is what is used
const R1 = "+919000000011"; // inside the 24-hour window (it "messaged" the business number)
const R2 = "+919000000022"; // window closed
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | false>, timeoutMs: number, stepMs = 2000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(stepMs);
  }
}

// ---- the fake Meta Graph API (the only thing faked)
interface GraphCall { kind: "template" | "text" | "document" | "media"; to?: string; body?: Record<string, any>; filename?: string; size?: number; mime?: string }
const graph: GraphCall[] = [];
const realFetch = globalThis.fetch;
let msgSeq = 0;
const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  const m = url.match(/^https:\/\/graph\.facebook\.com\/[^/]+\/E2EPHONEID\/(messages|media)$/);
  if (!m) throw new Error(`BLOCKED: unexpected network call to ${new URL(url).hostname}`);
  if (m[1] === "media") {
    const file = (init.body as FormData).get("file") as File;
    graph.push({ kind: "media", filename: file.name, size: file.size, mime: file.type });
    return json({ id: "media.e2e.1" });
  }
  const body = JSON.parse(init.body);
  graph.push({ kind: body.type === "template" ? "template" : body.type === "document" ? "document" : "text", to: body.to, body });
  return json({ messages: [{ id: `wamid.e2e.${++msgSeq}` }] });
}) as typeof fetch;

let server: Server;
let base = "";
let token = "";
let adminId = "";
const created = { users: [] as string[], configId: "", templateId: "", messageId: "" };
let timer: NodeJS.Timeout | null = null;

const api = async (method: string, path: string, body?: unknown, bearer: string | null = token) => {
  const res = await realFetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: ((await res.json().catch(() => ({}))) as { data?: any }).data };
};
const digits = (s: string | undefined) => (s ?? "").replace(/\D/g, "");
const callsTo = (phone: string) => graph.filter((c) => c.kind !== "media" && digits(c.to) === digits(phone));

/** A send time a short, dynamically chosen distance ahead, expressed in the test timezone. */
function planTime(aheadSeconds: number) {
  const target = new Date(Math.ceil((Date.now() + aheadSeconds * 1000) / 60_000) * 60_000);
  const lp = localParts(target, TZ);
  const sendTime = `${String(Math.floor(lp.minutes / 60)).padStart(2, "0")}:${String(lp.minutes % 60).padStart(2, "0")}`;
  return { target, sendTime, localDate: lp.date, minutes: lp.minutes };
}
const config = (sendTime: string) => ({
  enabled: true,
  recipients: [{ name: "Reachable", phone: R1 }, { name: "Window closed", phone: R2 }],
  sendTime,
  timezone: TZ,
  reportFor: "TODAY",
  templateName: "daily_team_report1",
  languageCode: "en",
  options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true },
  sendText: true,
  sendExcel: true,
});

before(async () => {
  const tag = randomUUID().slice(0, 8);
  const admin = await prisma.user.create({ data: { name: "E2E Admin", username: `e2e-admin-${tag}`, role: "ADMIN" } });
  const caller = await prisma.user.create({ data: { name: "E2E Caller", username: `e2e-caller-${tag}`, role: "SALESPERSON" } });
  adminId = admin.id;
  created.users.push(admin.id, caller.id);
  token = signToken({ sub: admin.id, role: "ADMIN", username: admin.username } as never);
  created.configId = (await prisma.whatsAppConfig.create({ data: { phoneNumberId: "E2EPHONEID", businessAccountId: "E2EWABA", isActive: true, credentials: encryptJson({ accessToken: "e2e-token-not-real", appSecret: "e2e-app-secret", verifyToken: "e2e-verify" }) } })).id;
  created.templateId = (await prisma.whatsAppTemplate.create({ data: { name: "daily_team_report1", provider: "META", language: "en", body: "x {{report_text}}", variables: ["report_text"], status: "APPROVED" } })).id;
  created.messageId = (await prisma.whatsAppMessage.create({ data: { provider: "META", direction: "INBOUND", status: "RECEIVED", normalizedContact: R1, fromNumber: R1, receivedAt: new Date(Date.now() - 3_600_000) } })).id;
  const app = express();
  app.use(express.json());
  app.use("/api", routes);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  if (timer) clearInterval(timer);
  globalThis.fetch = realFetch;
  server?.close();
  const automation = await prisma.reportAutomation.findUnique({ where: { ownerId: adminId }, select: { id: true } });
  if (automation) await prisma.reportAutomation.delete({ where: { id: automation.id } }); // cascades recipients, runs, per-recipient rows
  await prisma.whatsAppMessage.deleteMany({ where: { id: created.messageId } });
  await prisma.whatsAppTemplate.deleteMany({ where: { id: created.templateId } });
  await prisma.whatsAppConfig.deleteMany({ where: { id: created.configId } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.$disconnect();
});

describe("end to end: the running scheduler sends the due report at the saved time", { timeout: 900_000 }, () => {
  let first = planTime(100);

  it("1. saving through the API persists exactly what was chosen, and the page data (status) shows the saved time, zone and next run - nothing sent yet", async () => {
    const put = await api("PUT", "/report-automation/config", config(first.sendTime));
    assert.equal(put.status, 200);
    const got = await api("GET", "/report-automation/config");
    assert.deepEqual([got.data.enabled, got.data.sendTime, got.data.timezone, got.data.templateName, got.data.languageCode, got.data.reportFor, got.data.sendText, got.data.sendExcel], [true, first.sendTime, TZ, "daily_team_report1", "en", "TODAY", true, true]);
    assert.deepEqual(got.data.recipients.map((r: any) => [r.name, r.phone]), [["Reachable", R1], ["Window closed", R2]]);
    assert.deepEqual(got.data.options, { teamSummary: true, calls: true, leads: true, sales: true, followUps: true });
    const status = await api("GET", "/report-automation/status");
    assert.equal(new Date(status.data.nextRun.at).toISOString(), first.target.toISOString());
    assert.equal(status.data.nextRun.dueNow, false);
    assert.equal(status.data.lastScheduled, null);
    console.log(`      saved send time ${first.sendTime} ${TZ} -> next run ${first.target.toISOString()} (UTC), now ${new Date().toISOString()}`);
  });

  it("2. the real scheduler (started like server.ts starts it) creates NOTHING before the saved time and DOES create the scheduled run after it - nobody calls send", async () => {
    timer = startReportAutomationScheduler();
    while (Date.now() < first.target.getTime() - 1500) {
      assert.equal(await prisma.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 0, "no run before the saved local time");
      assert.equal(graph.length, 0);
      await sleep(5000);
    }
    const run = await until("the scheduled run to be created and finish", async () => {
      const r = await prisma.reportDelivery.findFirst({ where: { kind: "SCHEDULED" }, include: { recipientResults: true } });
      return r && r.status !== "SENDING" && r.recipientResults.every((x) => ![x.status, x.txtStatus, x.docStatus].some((st) => st === "PENDING" || st === "SENDING")) ? r : null;
    }, 150_000);
    assert.ok((run.scheduledFor?.getTime() ?? 0) >= first.target.getTime(), "created only once the saved time had passed");
    assert.equal(run.dedupeKey?.endsWith(`:${first.localDate}:${first.sendTime}:${first.localDate}`), true);
    assert.equal(run.reportDate, first.localDate, "report for the local day of the saved zone");
    console.log(`      scheduled run created at ${run.scheduledFor?.toISOString()} for ${run.reportDate}, status ${run.status}`);
  });

  it("3. the mocked Meta API received the template notification, the multi-line text and the Excel for the reachable recipient, and only the notification (saying why) for the closed-window one", async () => {
    const r1 = callsTo(R1);
    assert.deepEqual(r1.map((c) => c.kind), ["text", "document"], "window open: the detailed report then the Excel - no short template/summary message");
    const detail = r1[0]!.body!.text.body as string;
    assert.ok(!/Team report for|follow in the next messages/.test(detail));
    assert.match(detail, /^\*AYUSHWELLNESS \| DAILY TEAM REPORT\*\nDate: .+\nTimezone: Pacific\/Auckland\n\n\*TEAM OVERVIEW\*\nOrders: \d+/);
    assert.ok(detail.includes("\n\n*TELECALLER PERFORMANCE*\n\n*E2E Caller*\n") && !detail.includes("||"));
    const media = graph.find((c) => c.kind === "media")!;
    assert.deepEqual([media.filename, media.mime], [`AyushWellness_Daily_Report_${first.localDate}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
    assert.ok(media.size! > 1000);
    assert.deepEqual([r1[1]!.body!.document.id, r1[1]!.body!.document.filename], ["media.e2e.1", media.filename]);
    const r2 = callsTo(R2);
    assert.deepEqual(r2.map((c) => c.kind), ["template"], "window closed: only the approved template, and no unsupported free-form attempt");
    assert.deepEqual([r2[0]!.body!.template.name, r2[0]!.body!.template.language.code, r2[0]!.body!.template.components[0].parameters[0].parameter_name], ["daily_team_report1", "en", "report_text"]);
    assert.ok(!/[\n\t]/.test(r2[0]!.body!.template.components[0].parameters[0].text));
    assert.match(r2[0]!.body!.template.components[0].parameters[0].text, /24-hour window for this number is closed/);
  });

  it("4. persisted status per recipient and part, heartbeat, last scheduled attempt and the recalculated next run", async () => {
    const run = (await prisma.reportDelivery.findFirst({ where: { kind: "SCHEDULED" }, include: { recipientResults: true } }))!;
    const by = Object.fromEntries(run.recipientResults.map((r) => [r.phone, r]));
    assert.deepEqual([by[R1]!.status, by[R1]!.txtStatus, by[R1]!.docStatus], ["SKIPPED", "SENT", "SENT"]);
    assert.ok(by[R1]!.txtProviderMessageId && by[R1]!.docProviderMessageId && !by[R1]!.providerMessageId, "no template was sent to the open-window recipient");
    assert.deepEqual([by[R2]!.status, by[R2]!.txtStatus, by[R2]!.docStatus], ["SENT", "WAITING_FOR_REPLY", "WAITING_FOR_REPLY"]);
    assert.match(by[R2]!.txtError ?? "", /24 hours of the recipient's last message.*Nothing was sent/);
    assert.equal(run.status, "PENDING", "not reported as fully successful, nor failed: waiting for the reply");
    const hb = (await prisma.reportSchedulerState.findUnique({ where: { id: 1 } }))!;
    assert.ok(hb.lastTickAt!.getTime() >= first.target.getTime());
    assert.equal(hb.lastSource, "scheduler");
    const status = await api("GET", "/report-automation/status");
    assert.equal(status.data.scheduler.running, true);
    assert.equal(status.data.lastScheduled.id, run.id);
    assert.equal(new Date(status.data.nextRun.at).toISOString(), localInstant(shiftDate(first.localDate, 1), first.minutes, TZ).toISOString(), "tomorrow at the saved local time");
    const list = await api("GET", "/report-automation/deliveries");
    assert.deepEqual(list.data.items.map((i: any) => i.kind), ["SCHEDULED"]);
  });

  it("5. RESTART: stopping and starting the scheduler, and an authenticated cron tick, create no second run and send nothing again; a wrong cron secret is refused", async () => {
    const callsBefore = graph.length;
    clearInterval(timer!);
    timer = startReportAutomationScheduler(); // a fresh process start also ticks immediately
    await sleep(6000);
    assert.equal(await prisma.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 1);
    assert.equal(graph.length, callsBefore);
    const secret = process.env.REPORT_CRON_SECRET!;
    const bad = await realFetch(`${base}/report-automation/cron/tick`, { method: "POST", headers: { "x-cron-secret": "wrong" } });
    assert.equal(bad.status, 401);
    const good = await realFetch(`${base}/report-automation/cron/tick`, { method: "POST", headers: { "x-cron-secret": secret } });
    assert.equal(good.status, 200);
    assert.deepEqual(((await good.json()) as { data: object }).data, { checked: 1, started: 0 });
    assert.equal(await prisma.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 1);
    assert.equal(graph.length, callsBefore);
    assert.equal((await prisma.reportSchedulerState.findUnique({ where: { id: 1 } }))!.lastSource, "cron");
  });

  it("6. CHANGING the saved time (no restart, no redeploy): the new time is reloaded, the next run moves, and the scheduler sends at the NEW time", async () => {
    const second = planTime(100);
    assert.notEqual(second.sendTime, first.sendTime);
    const callsBefore = graph.length;
    assert.equal((await api("PUT", "/report-automation/config", config(second.sendTime))).status, 200);
    const got = await api("GET", "/report-automation/config");
    assert.equal(got.data.sendTime, second.sendTime);
    const status = await api("GET", "/report-automation/status");
    assert.equal(new Date(status.data.nextRun.at).toISOString(), second.target.toISOString());
    while (Date.now() < second.target.getTime() - 1500) {
      assert.equal(await prisma.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 1, "no new run before the new saved time");
      await sleep(5000);
    }
    const run2 = await until("the second scheduled run", async () => {
      const r = await prisma.reportDelivery.findFirst({ where: { kind: "SCHEDULED", dedupeKey: { endsWith: `:${second.sendTime}:${first.localDate}` } }, include: { recipientResults: true } });
      return r && r.status !== "SENDING" && r.recipientResults.every((x) => ![x.status, x.txtStatus, x.docStatus].some((st) => st === "PENDING" || st === "SENDING")) ? r : null;
    }, 150_000);
    assert.ok((run2.scheduledFor?.getTime() ?? 0) >= second.target.getTime());
    assert.equal(await prisma.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 2);
    assert.deepEqual(graph.slice(callsBefore).map((c) => c.kind).sort(), ["document", "media", "template", "text"], "the new occurrence: the template only for the closed-window recipient, the text, the upload and the document for the reachable one");
    console.log(`      time changed ${first.sendTime} -> ${second.sendTime}: second run created at ${run2.scheduledFor?.toISOString()}`);
    // and it is not repeated
    await sleep(65_000);
    assert.equal(await prisma.reportDelivery.count({ where: { kind: "SCHEDULED" } }), 2);
    assert.equal(graph.length - callsBefore, 4, "still exactly one occurrence's worth of calls");
  });

  it("7. nothing outside the fake Graph API was ever contacted, and no test-send was recorded", async () => {
    assert.ok(graph.every((c) => c.kind !== "text" || typeof c.body?.text?.body === "string"));
    assert.equal(await prisma.reportDelivery.count({ where: { kind: "TEST" } }), 0);
  });
});
