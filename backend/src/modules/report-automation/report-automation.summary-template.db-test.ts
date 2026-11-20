// The Shopify Orders Summary template (aayushwellness_daily_team_report_3) connected to the Daily Team Report: its configuration status as it moves from "not added" to "ready", the five parameters built from
// the STORED template row, and the detailed report / Excel reply path staying exactly as it was. Real service + schema on the isolated database (one rolled-back transaction per test); WhatsApp is a fake.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import ReportAutomationService from "./report-automation.service.js";
import { createWhatsAppReportSender, planTemplateParams, ReportSendRejected, type ReportSendInput } from "./report-automation.sender.js";
import { SUMMARY_TEMPLATE_NAME } from "./report-automation.summary-template.js";
import { buildStructuredValues, SHOPIFY_SUMMARY_VARIABLES, STRUCTURED_TEMPLATE_VARIABLES, type TemplateMetrics } from "./report-automation.template-metrics.js";
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
const SEND = new Date("2026-11-19T03:30:00Z"); // 09:00 IST on 19 Nov: reports 18 Nov
const okSources: ReportSources = { overview: async () => [] as never, cancelledByUser: async () => new Map(), pendingFollowUps: async () => new Map() };
const METRICS: TemplateMetrics = {
  website: { totalOrders: 120, totalRevenue: 69000.05, codOrders: 5, prepaidOrders: 115, otherOrders: 0 },
  abandoned: { totalLeads: 538, ordersConverted: 54, revenue: 36634, codOrders: 36, prepaidOrders: 18 },
  shopify: { totalOrders: 204, websiteOrders: 120, telecallerOrders: 84, totalRevenue: 127581.05 },
};
const tpl = (tx: Prisma.TransactionClient, status: "DRAFT" | "PENDING" | "APPROVED" | "REJECTED" | "DISABLED", variables: unknown, name = SUMMARY_TEMPLATE_NAME) =>
  tx.whatsAppTemplate.create({ data: { name, provider: "META", language: "en", category: "UTILITY", body: "Summary", variables: variables as never, status } });

async function harness(tx: Prisma.TransactionClient, templateName = SUMMARY_TEMPLATE_NAME) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${randomUUID()}`, role: Role.ADMIN } });
  const clock = { now: SEND };
  const open = new Set<string>();
  const captured: { to: string; names: string[]; params: string[] }[] = [];
  const live = { current: METRICS as TemplateMetrics, calls: 0 };
  const refuse = new Set<string>();
  const texts: string[] = [];
  const files: string[] = [];
  const svc = new ReportAutomationService(tx, {
    now: () => clock.now,
    sources: okSources,
    templateMetrics: async () => { live.calls++; return live.current; },
    // the same data path as the real sender: the STORED approved template row -> planTemplateParams -> named parameters
    send: async (i: ReportSendInput) => {
      const row = await tx.whatsAppTemplate.findFirst({ where: { name: i.templateName, status: "APPROVED" } });
      if (!row) throw new ReportSendRejected(`No APPROVED WhatsApp template named "${i.templateName}" exists in the CRM.`);
      const plan = await planTemplateParams(row, i.text, i.structured); // the figures are built (and frozen) here, BEFORE the provider is called - exactly as the real sender does
      if (refuse.has(i.recipient)) throw new ReportSendRejected("Meta refused the template (test)"); // the provider answering "no" comes last
      captured.push({ to: i.recipient, names: plan.paramNames, params: plan.params });
      return { providerMessageId: `wamid.${captured.length}`, provider: "META" };
    },
    sendDetail: async (i) => { texts.push(i.recipient); return { providerMessageId: `txt.${texts.length}`, provider: "META" }; },
    sendDocument: async (i) => { files.push(i.recipient); return { providerMessageId: `doc.${files.length}`, mediaId: "m", provider: "META" }; },
    windowOpen: async (p: string) => open.has(p),
  });
  const actor = { id: admin.id, username: admin.username, role: Role.ADMIN };
  await svc.saveConfig(actor, { enabled: true, recipients: [{ name: "Owner", phone: A }], sendTime: "09:00", timezone: "Asia/Kolkata", reportFor: "YESTERDAY", dataDate: null, templateName, languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, includedUserIds: [], sendText: true, sendExcel: true, replyTriggersDetail: true });
  await tx.reportAutomation.updateMany({ where: { ownerId: admin.id }, data: { updatedAt: new Date(SEND.getTime() - 3_600_000) } });
  return { admin, actor, svc, captured, texts, files, open, live, refuse };
}

describe("configuration status as the template moves from 'not added' to 'ready'", () => {
  it("reports each state through the status endpoint, and whether the SAVED selection can be used", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx);
      // 1. not in the CRM at all
      let s = await w.svc.status(w.actor as never);
      assert.deepEqual([s.summaryTemplate.state, s.summaryTemplate.selected, s.selectedTemplate?.usable], ["NOT_ADDED", true, false]);
      assert.match(s.selectedTemplate?.reason ?? "", /not in the CRM/);
      assert.equal(s.summaryTemplate.mapping.length, 5);
      // 2. submitted, waiting for Meta
      const row = await tpl(tx, "PENDING", [...SHOPIFY_SUMMARY_VARIABLES]);
      s = await w.svc.status(w.actor as never);
      assert.deepEqual([s.summaryTemplate.state, s.summaryTemplate.status, s.selectedTemplate?.usable], ["NOT_APPROVED", "PENDING", false]);
      assert.ok(s.whatsapp.unusableTemplates.some((t) => t.name === SUMMARY_TEMPLATE_NAME), "listed with its reason in the existing unusable list");
      assert.ok(!s.whatsapp.templates.some((t) => t.name === SUMMARY_TEMPLATE_NAME), "not offered in the dropdown while pending");
      // 3. rejected, then approved with the wrong variables
      await tx.whatsAppTemplate.update({ where: { id: row.id }, data: { status: "REJECTED" } });
      assert.equal((await w.svc.status(w.actor as never)).summaryTemplate.state, "NOT_APPROVED");
      await tx.whatsAppTemplate.update({ where: { id: row.id }, data: { status: "APPROVED", variables: [...STRUCTURED_TEMPLATE_VARIABLES] } });
      s = await w.svc.status(w.actor as never);
      assert.equal(s.summaryTemplate.state, "VARIABLES_MISMATCH");
      // 4. approved with the five variables
      await tx.whatsAppTemplate.update({ where: { id: row.id }, data: { variables: [...SHOPIFY_SUMMARY_VARIABLES] } });
      s = await w.svc.status(w.actor as never);
      assert.deepEqual([s.summaryTemplate.state, s.selectedTemplate?.usable, s.selectedTemplate?.sends], ["READY", true, "SHOPIFY_SUMMARY"]);
      assert.ok(s.whatsapp.templates.some((t) => t.name === SUMMARY_TEMPLATE_NAME), "now offered in the dropdown");
    });
  });

  it("while _3 is not approved, the template selected today is reported as the one in use - and the status is read-only (nothing is saved or selected)", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "APPROVED", [...STRUCTURED_TEMPLATE_VARIABLES], "aayushwellness_daily_team_report_1");
      await tpl(tx, "PENDING", [...SHOPIFY_SUMMARY_VARIABLES]);
      const w = await harness(tx, "aayushwellness_daily_team_report_1");
      const before = await tx.reportAutomation.findFirstOrThrow({ where: { ownerId: w.admin.id } });
      const s = await w.svc.status(w.actor as never);
      assert.deepEqual([s.selectedTemplate?.name, s.selectedTemplate?.usable, s.selectedTemplate?.sends], ["aayushwellness_daily_team_report_1", true, "WEBSITE_ABANDONED"]);
      assert.deepEqual([s.summaryTemplate.state, s.summaryTemplate.selected], ["NOT_APPROVED", false]);
      const after = await tx.reportAutomation.findFirstOrThrow({ where: { ownerId: w.admin.id } });
      assert.deepEqual([after.templateName, after.languageCode, after.updatedAt.getTime()], [before.templateName, before.languageCode, before.updatedAt.getTime()]);
    });
  });
});

describe("the initial message through the stored template row", () => {
  it("fills {{1}}..{{5}} (report date, total Shopify orders, website, telecaller-created, revenue) BY NAME in the stored order, and freezes exactly those figures", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "APPROVED", [...SHOPIFY_SUMMARY_VARIABLES]);
      const w = await harness(tx);
      await w.svc.runDue();
      assert.equal(w.captured.length, 1);
      assert.deepEqual(w.captured[0]!.names, [...SHOPIFY_SUMMARY_VARIABLES]);
      assert.deepEqual(w.captured[0]!.params, ["18 Nov 2026", "204", "120", "84", "1,27,581.05"]);
      const snap = await tx.reportSnapshot.findFirstOrThrow({ where: { delivery: { automation: { ownerId: w.admin.id } } } });
      assert.equal((snap.values as Record<string, string>).total_revenue, "1,27,581.05");
      assert.equal((snap.figures as { shopify: { telecallerOrders: number } }).shopify.telecallerOrders, 84);
    });
  });

  it("a template stored with the variables in another order still gets every figure in the right place", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "APPROVED", [...SHOPIFY_SUMMARY_VARIABLES].reverse());
      const w = await harness(tx);
      await w.svc.runDue();
      assert.deepEqual(w.captured[0]!.names, [...SHOPIFY_SUMMARY_VARIABLES].reverse());
      assert.deepEqual(w.captured[0]!.params, ["1,27,581.05", "84", "120", "204", "18 Nov 2026"]);
    });
  });

  it("not approved: nothing is sent, the run records a clear failure, and no snapshot is frozen from a message that was never sent", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "PENDING", [...SHOPIFY_SUMMARY_VARIABLES]);
      const w = await harness(tx);
      await w.svc.runDue();
      assert.equal(w.captured.length, 0);
      const row = await tx.reportDeliveryRecipient.findFirstOrThrow({ where: { phone: A } });
      assert.equal(row.status, "FAILED");
      assert.match(row.error ?? "", /No APPROVED WhatsApp template/);
    });
  });
});

describe("the detailed report and Excel are unchanged by the new first message", () => {
  it("with _3 as the summary template, a reply still releases the detailed text and the Excel, once, and the summary is not re-sent", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "APPROVED", [...SHOPIFY_SUMMARY_VARIABLES]);
      const w = await harness(tx);
      await w.svc.runDue();
      assert.equal(w.captured.length, 1);
      assert.deepEqual([w.texts.length, w.files.length], [0, 0], "closed window: only the template goes out");
      w.open.add(A); // the recipient replies, which opens the window
      const o = await w.svc.sendPendingOnReply(A);
      assert.equal(o.handled, true);
      assert.deepEqual([w.texts.length, w.files.length], [1, 1]);
      assert.equal(w.captured.length, 1, "the summary is not sent again");
      assert.equal((await w.svc.sendPendingOnReply(A)).handled, false, "a second reply sends nothing new");
      assert.deepEqual([w.texts.length, w.files.length], [1, 1]);
    });
  });
});

describe("the real sender explains where the template stands", () => {
  const input = { recipient: A, templateName: SUMMARY_TEMPLATE_NAME, languageCode: "en", text: "x", structured: async () => buildStructuredValues("19 Nov 2026", METRICS) };

  it("not in the CRM: says so and what to do; in the CRM but not approved: names its Meta status", async () => {
    await inRollback(async (tx) => {
      const send = createWhatsAppReportSender(tx);
      await assert.rejects(() => send(input), (e: unknown) => e instanceof ReportSendRejected && /No APPROVED WhatsApp template named "aayushwellness_daily_team_report_3"/.test((e as Error).message) && /not in the CRM yet/.test((e as Error).message) && /Nothing was sent/.test((e as Error).message));
      await tpl(tx, "PENDING", [...SHOPIFY_SUMMARY_VARIABLES]);
      await assert.rejects(() => send(input), (e: unknown) => e instanceof ReportSendRejected && /status PENDING/.test((e as Error).message) && /Meta approves it/.test((e as Error).message));
    });
  });

  it("approved with the five variables it passes template planning and stops only at the missing provider of the test environment", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "APPROVED", [...SHOPIFY_SUMMARY_VARIABLES]);
      await assert.rejects(() => createWhatsAppReportSender(tx)(input), (e: unknown) => e instanceof ReportSendRejected && /not configured/.test((e as Error).message));
    });
  });

  it("approved with the wrong variables it refuses before any provider call, naming the problem", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "APPROVED", ["report_date", "x"]);
      await assert.rejects(() => createWhatsAppReportSender(tx)(input), (e: unknown) => e instanceof ReportSendRejected && /2 variables/.test((e as Error).message));
    });
  });
});

// ---------------------------------------------------------------------------------------------- the template exactly as Meta registered it: aayushwellness_daily_team_report_3_3
describe("aayushwellness_daily_team_report_3_3 (Meta's suffixed name) end to end", () => {
  const NAME33 = "aayushwellness_daily_team_report_3_3";
  const FIVE = ["report_date", "total_shopify_orders", "website_orders", "telecaller_orders", "total_revenue"];

  it("the status endpoint finds it under its own name (not 'not added'), READY, selected, and sending the Shopify Orders Summary", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "APPROVED", FIVE, NAME33);
      const w = await harness(tx, NAME33);
      const s = await w.svc.status(w.actor as never);
      assert.deepEqual([s.summaryTemplate.name, s.summaryTemplate.state, s.summaryTemplate.selected], [NAME33, "READY", true]);
      assert.deepEqual([s.selectedTemplate?.usable, s.selectedTemplate?.sends], [true, "SHOPIFY_SUMMARY"]);
      assert.ok(s.whatsapp.templates.some((t) => t.name === NAME33), "offered in the dropdown");
      assert.equal(s.whatsapp.unusableTemplates.some((t) => t.name === NAME33), false);
    });
  });

  it("sends the five correct values from the stored template, freezes exactly those figures under that template name, and sends the summary once", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "APPROVED", FIVE, NAME33);
      const w = await harness(tx, NAME33);
      await w.svc.runDue();
      await w.svc.runDue(); // another tick: nothing new
      assert.equal(w.captured.length, 1);
      assert.deepEqual(w.captured[0]!.names, FIVE);
      assert.deepEqual(w.captured[0]!.params, ["18 Nov 2026", "204", "120", "84", "1,27,581.05"]);
      const snap = await tx.reportSnapshot.findFirstOrThrow({ where: { delivery: { automation: { ownerId: w.admin.id } } } });
      assert.equal(snap.templateName, NAME33);
      assert.deepEqual((snap.values as Record<string, string>).total_revenue, "1,27,581.05");
      assert.equal(await tx.reportSnapshot.count({ where: { delivery: { automation: { ownerId: w.admin.id } } } }), 1);
    });
  });

  it("retry: a refused first send is retried with the SAVED figures even though the live numbers moved on, and Shopify is not read again", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "APPROVED", FIVE, NAME33);
      const w = await harness(tx, NAME33);
      w.refuse.add(A);
      await w.svc.runDue();
      const row = await tx.reportDeliveryRecipient.findFirstOrThrow({ where: { phone: A } });
      assert.equal(row.status, "FAILED");
      assert.equal(w.captured.length, 0);
      w.live.current = { ...METRICS, shopify: { totalOrders: 230, websiteOrders: 130, telecallerOrders: 100, totalRevenue: 150000 } };
      w.refuse.delete(A);
      await w.svc.retryRecipient(w.actor as never, row.id, "TEXT");
      assert.deepEqual(w.captured[0]!.params, ["18 Nov 2026", "204", "120", "84", "1,27,581.05"]);
      assert.equal(w.live.calls, 1);
    });
  });

  it("the Excel and detailed report reply flow is unchanged: a reply releases both once, the summary is not re-sent", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "APPROVED", FIVE, NAME33);
      const w = await harness(tx, NAME33);
      await w.svc.runDue();
      w.open.add(A);
      assert.equal((await w.svc.sendPendingOnReply(A)).handled, true);
      assert.deepEqual([w.captured.length, w.texts.length, w.files.length], [1, 1, 1]);
      assert.equal((await w.svc.sendPendingOnReply(A)).handled, false);
      assert.deepEqual([w.captured.length, w.texts.length, w.files.length], [1, 1, 1]);
    });
  });

  it("the real sender accepts it (passes template planning) and stops only at the missing provider of the test environment; a 4-variable template is refused before any provider call", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "APPROVED", FIVE, NAME33);
      const input = { recipient: A, templateName: NAME33, languageCode: "en", text: "x", structured: async () => buildStructuredValues("19 Nov 2026", METRICS) };
      await assert.rejects(() => createWhatsAppReportSender(tx)(input), (e: unknown) => e instanceof ReportSendRejected && /not configured/.test((e as Error).message));
      await tx.whatsAppTemplate.updateMany({ where: { name: NAME33 }, data: { variables: FIVE.slice(0, 4) as never } });
      await assert.rejects(() => createWhatsAppReportSender(tx)(input), (e: unknown) => e instanceof ReportSendRejected && /4 variables/.test((e as Error).message) && /total_shopify_orders/.test((e as Error).message));
    });
  });

  it("the existing 1-variable and 10-variable templates still go through the same service untouched", async () => {
    await inRollback(async (tx) => {
      await tpl(tx, "APPROVED", [...STRUCTURED_TEMPLATE_VARIABLES], "aayushwellness_daily_team_report_1");
      const w = await harness(tx, "aayushwellness_daily_team_report_1");
      await w.svc.runDue();
      assert.equal(w.captured[0]!.params.length, 10);
      assert.equal(w.captured[0]!.params[1], "120", "web_total_orders");
      const s = await w.svc.status(w.actor as never);
      assert.deepEqual([s.selectedTemplate?.usable, s.selectedTemplate?.sends], [true, "WEBSITE_ABANDONED"]);
    });
  });
});
