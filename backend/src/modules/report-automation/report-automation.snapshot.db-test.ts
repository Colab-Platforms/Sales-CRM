// Point-in-time snapshots of the initial Daily Team Report message: written once per run when the figures are first built, immutable afterwards (a database trigger refuses UPDATEs), reused by every retry.
// Real service + schema on the isolated database (one rolled-back transaction per test); WhatsApp and the live figures are fakes - nothing is sent anywhere.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import ReportAutomationService from "./report-automation.service.js";
import { ReportSendRejected, type ReportSendInput } from "./report-automation.sender.js";
import type { ReportSources } from "./report-automation.report.js";
import type { StructuredNeed, StructuredValues, TemplateMetrics } from "./report-automation.template-metrics.js";

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
const okSources: ReportSources = { overview: async () => [] as never, cancelledByUser: async () => new Map(), pendingFollowUps: async () => new Map() };
const SEND = new Date("2026-11-19T03:30:00Z"); // 09:00 IST on 19 Nov: reports 18 Nov
const metrics = (conv: number, rev: number): TemplateMetrics => ({
  website: { totalOrders: 78, totalRevenue: 48372, codOrders: 3, prepaidOrders: 74, otherOrders: 1 },
  abandoned: { totalLeads: 442, ordersConverted: conv, revenue: rev, codOrders: conv - 8, prepaidOrders: 8 },
});

async function harness(tx: Prisma.TransactionClient, opts: { recipients?: { name: string; phone: string }[]; need?: StructuredNeed } = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${randomUUID()}`, role: Role.ADMIN } });
  const clock = { now: SEND };
  const live = { current: metrics(32, 20793) as TemplateMetrics, calls: 0 };
  const sent: { to: string; values: StructuredValues }[] = [];
  const refuse = new Set<string>();
  const svc = new ReportAutomationService(tx, {
    now: () => clock.now,
    sources: okSources,
    templateMetrics: async () => { live.calls++; return live.current; },
    // the fake sender reads the figures exactly as the real one does: through input.structured()
    send: async (i: ReportSendInput) => {
      const values = await i.structured!(opts.need);
      if (refuse.has(i.recipient)) throw new ReportSendRejected("Meta refused the template (test)");
      sent.push({ to: i.recipient, values });
      return { providerMessageId: `wamid.${i.recipient}.${sent.length}`, provider: "META" };
    },
    sendDocument: async () => ({ providerMessageId: "d", mediaId: "m", provider: "META" }),
    sendDetail: async () => ({ providerMessageId: "t", provider: "META" }),
    windowOpen: async () => false,
  });
  const actor = { id: admin.id, username: admin.username, role: Role.ADMIN };
  await svc.saveConfig(actor, { enabled: true, recipients: opts.recipients ?? [{ name: "Owner", phone: A }, { name: "Ops", phone: B }], sendTime: "09:00", timezone: "Asia/Kolkata", reportFor: "YESTERDAY", dataDate: null, templateName: "daily_team_report", languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, includedUserIds: [], sendText: true, sendExcel: true, replyTriggersDetail: true });
  await tx.reportAutomation.updateMany({ where: { ownerId: admin.id }, data: { updatedAt: new Date(SEND.getTime() - 3_600_000) } });
  return { admin, actor, clock, live, sent, refuse, svc };
}
const snapshotsOf = (tx: Prisma.TransactionClient, ownerId: string) => tx.reportSnapshot.findMany({ where: { delivery: { automation: { ownerId } } } });

describe("a snapshot is written when the initial message is first built", () => {
  it("stores the exact values sent, the numbers behind them, the report date, the generation time and the template", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx);
      await w.svc.runDue();
      const [s] = await snapshotsOf(tx, w.admin.id);
      assert.ok(s);
      assert.equal(s.reportDate, "2026-11-18");
      assert.equal(s.generatedAt.toISOString(), SEND.toISOString());
      assert.equal(s.templateName, "daily_team_report");
      assert.equal(s.timezone, "Asia/Kolkata");
      const v = s.values as Record<string, string>;
      assert.deepEqual([v.report_date, v.web_total_orders, v.web_other_orders, v.aband_orders_conv, v.aband_revenue], ["18 Nov 2026", "78", "1", "32", "20,793"]);
      assert.deepEqual(w.sent[0]!.values, s.values, "what was sent IS what was stored");
      assert.deepEqual((s.figures as { abandoned: { ordersConverted: number } }).abandoned.ordersConverted, 32);
    });
  });

  it("one snapshot per run however many recipients, ticks or restarts; the live figures are read once", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx);
      await w.svc.runDue();
      await w.svc.runDue();
      await w.svc.runDue();
      assert.equal((await snapshotsOf(tx, w.admin.id)).length, 1);
      assert.equal(w.live.calls, 1, "two recipients, three ticks: one read");
      assert.equal(w.sent.length, 2);
      assert.deepEqual(w.sent[0]!.values, w.sent[1]!.values, "every recipient gets the same figures");
    });
  });

  it("two creators at the same instant: the unique delivery id leaves exactly one row and both use it", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx);
      await w.svc.runDue();
      const run = await tx.reportDelivery.findFirstOrThrow({ where: { automation: { ownerId: w.admin.id } } });
      const again = await tx.reportSnapshot.createMany({ data: [{ deliveryId: run.id, reportDate: "2026-11-18", timezone: "Asia/Kolkata", generatedAt: new Date(), values: { x: "late" }, figures: {} }], skipDuplicates: true });
      assert.equal(again.count, 0);
      assert.equal((await snapshotsOf(tx, w.admin.id)).length, 1);
    });
  });
});

describe("history never changes", () => {
  it("later orders, cancellations or conversions do not alter a stored snapshot, and the next day's report gets its own", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx);
      await w.svc.runDue();
      const before = (await snapshotsOf(tx, w.admin.id))[0]!;
      w.live.current = metrics(43, 27744); // the afternoon: more conversions, a revert
      await w.svc.runDue();
      const same = (await snapshotsOf(tx, w.admin.id))[0]!;
      assert.deepEqual(same.values, before.values);
      assert.deepEqual(same.figures, before.figures);
      // the next morning is a new run with its own snapshot
      w.clock.now = new Date("2026-11-20T03:30:00Z");
      await w.svc.runDue();
      const all = await snapshotsOf(tx, w.admin.id);
      assert.equal(all.length, 2);
      const next = all.find((s) => s.reportDate === "2026-11-19")!;
      assert.equal((next.values as Record<string, string>).aband_orders_conv, "43");
      assert.equal((all.find((s) => s.reportDate === "2026-11-18")!.values as Record<string, string>).aband_orders_conv, "32", "yesterday's report still says what it said");
    });
  });

  it("the database refuses to UPDATE a snapshot, whoever tries", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx);
      await w.svc.runDue();
      const s = (await snapshotsOf(tx, w.admin.id))[0]!;
      await tx.$executeRawUnsafe(`DO $$ BEGIN
        UPDATE report_snapshots SET values = '{"hacked":"1"}'::jsonb WHERE id = '${s.id}'::uuid;
        RAISE EXCEPTION 'NOT_BLOCKED';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%immutable%' THEN RAISE; END IF;
      END $$`);
      const after = (await snapshotsOf(tx, w.admin.id))[0]!;
      assert.deepEqual(after.values, s.values);
      await tx.$executeRawUnsafe(`DO $$ BEGIN
        UPDATE report_snapshots SET report_date = '2000-01-01' WHERE id = '${s.id}'::uuid;
        RAISE EXCEPTION 'NOT_BLOCKED';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%immutable%' THEN RAISE; END IF;
      END $$`);
      assert.equal((await snapshotsOf(tx, w.admin.id))[0]!.reportDate, "2026-11-18");
    });
  });
});

describe("failed WhatsApp delivery", () => {
  it("a refused send still leaves the snapshot, records the failure, and the retry resends the SAME figures even though the live numbers moved on", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, { recipients: [{ name: "Owner", phone: A }] });
      w.refuse.add(A);
      await w.svc.runDue();
      const snap = (await snapshotsOf(tx, w.admin.id))[0]!;
      assert.ok(snap, "the figures were generated even though delivery failed");
      const row = await tx.reportDeliveryRecipient.findFirstOrThrow({ where: { phone: A } });
      assert.equal(row.status, "FAILED");
      assert.match(row.error ?? "", /refused/);
      assert.equal(w.sent.length, 0);
      w.live.current = metrics(43, 27744);
      w.refuse.delete(A);
      await w.svc.retryRecipient(w.actor as never, row.id, "TEXT");
      assert.equal(w.sent.length, 1);
      assert.equal(w.sent[0]!.values.aband_orders_conv, "32", "the retry carries the 09:00 figures, not the afternoon's");
      assert.equal(w.live.calls, 1, "the live figures were not read again");
      assert.equal((await snapshotsOf(tx, w.admin.id)).length, 1);
    });
  });

  it("figures that could not be fully read are sent as N/A but NOT frozen; a later retry may read them and then freezes the complete set", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, { recipients: [{ name: "Owner", phone: A }] });
      w.live.current = { website: metrics(1, 1).website, abandoned: null };
      w.refuse.add(A);
      await w.svc.runDue();
      assert.equal((await snapshotsOf(tx, w.admin.id)).length, 0);
      w.live.current = metrics(32, 20793);
      w.refuse.delete(A);
      const row = await tx.reportDeliveryRecipient.findFirstOrThrow({ where: { phone: A } });
      await w.svc.retryRecipient(w.actor as never, row.id, "TEXT");
      assert.equal((await snapshotsOf(tx, w.admin.id)).length, 1);
      assert.equal(w.sent[0]!.values.aband_orders_conv, "32");
    });
  });
});

describe("snapshot history view", () => {
  it("lists frozen figures newest first with each run's delivery state (masked numbers, provider ids), only for the owner", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx);
      await w.svc.runDue();
      w.live.current = metrics(43, 27744);
      w.clock.now = new Date("2026-11-20T03:30:00Z");
      await w.svc.runDue();
      const h = await w.svc.snapshots(w.actor as never, 1, 10);
      assert.equal(h.pagination.totalItems, 2);
      assert.deepEqual(h.items.map((i) => [i.reportDate, i.values.aband_orders_conv]), [["2026-11-19", "43"], ["2026-11-18", "32"]]);
      const d = h.items[1]!.deliveries;
      assert.equal(d.length, 2);
      assert.ok(d.every((x) => x.providerMessageId && x.phone.includes("•") && !x.phone.includes("98765")));
      assert.equal(h.items[1]!.figures.website!.otherOrders, 1);
      const other = await tx.user.create({ data: { name: "Other", username: `o-${randomUUID()}`, role: Role.ADMIN } });
      assert.deepEqual(await w.svc.snapshots({ id: other.id, username: other.username, role: Role.ADMIN } as never, 1, 10), { items: [], pagination: { page: 1, pageSize: 10, totalItems: 0, totalPages: 1 } });
    });
  });

  it("only an Admin or Manager can read it", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx);
      await assert.rejects(() => w.svc.snapshots({ id: w.admin.id, username: "x", role: Role.SALESPERSON } as never, 1, 10), /Forbidden/);
    });
  });
});

describe("a snapshot problem never stops a report", () => {
  it("if the snapshot table cannot be read or written, the message is still sent from the live figures (not UNCERTAIN, not lost)", async () => {
    await inRollback(async (tx) => {
      const broken = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "reportSnapshot") return { findUnique: async () => { throw new Error("relation report_snapshots is locked"); }, createMany: async () => { throw new Error("could not write"); }, findMany: async () => [], count: async () => 0 };
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as unknown as Prisma.TransactionClient;
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${randomUUID()}`, role: Role.ADMIN } });
      const sent: string[] = [];
      const svc = new ReportAutomationService(broken, {
        now: () => SEND, sources: okSources,
        templateMetrics: async () => metrics(32, 20793),
        send: async (i: ReportSendInput) => { sent.push((await i.structured!()).aband_orders_conv); return { providerMessageId: "wamid.x", provider: "META" }; },
        sendDocument: async () => ({ providerMessageId: "d", mediaId: "m", provider: "META" }), sendDetail: async () => ({ providerMessageId: "t", provider: "META" }), windowOpen: async () => false,
      });
      const actor = { id: admin.id, username: admin.username, role: Role.ADMIN };
      await svc.saveConfig(actor, { enabled: true, recipients: [{ name: "Owner", phone: A }], sendTime: "09:00", timezone: "Asia/Kolkata", reportFor: "YESTERDAY", dataDate: null, templateName: "daily_team_report", languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, includedUserIds: [], sendText: true, sendExcel: true, replyTriggersDetail: true });
      await tx.reportAutomation.updateMany({ where: { ownerId: admin.id }, data: { updatedAt: new Date(SEND.getTime() - 3_600_000) } });
      await svc.runDue();
      assert.deepEqual(sent, ["32"], "the report went out from the live figures");
      const row = await tx.reportDeliveryRecipient.findFirstOrThrow({ where: { phone: A } });
      assert.equal(row.status, "SENT", "not UNCERTAIN");
    });
  });
});

// ---------------------------------------------------------------------------------------------- Shopify Orders Summary snapshots
describe("Shopify Orders Summary snapshot: 204 / 120 / 84 / 1,27,581.05", () => {
  const SHOPIFY: TemplateMetrics = {
    website: { totalOrders: 120, totalRevenue: 69000.05, codOrders: 5, prepaidOrders: 115, otherOrders: 0 },
    abandoned: null, // the new template does not send abandoned figures: their absence must not stop it freezing
    shopify: { totalOrders: 204, websiteOrders: 120, telecallerOrders: 84, totalRevenue: 127581.05 },
  };
  const need: StructuredNeed = { shopify: true };

  it("is frozen with the exact figures sent and the Shopify set stored, even though the abandoned section was not read", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, { need });
      w.live.current = SHOPIFY;
      await w.svc.runDue();
      const [s] = await snapshotsOf(tx, w.admin.id);
      assert.ok(s, "frozen");
      const v = s.values as Record<string, string>;
      assert.deepEqual([v.report_date, v.total_shopify_orders, v.website_orders, v.telecaller_orders, v.total_revenue], ["18 Nov 2026", "204", "120", "84", "1,27,581.05"]);
      assert.deepEqual((s.figures as { shopify: unknown }).shopify, { totalOrders: 204, websiteOrders: 120, telecallerOrders: 84, totalRevenue: 127581.05 });
      assert.deepEqual([w.sent[0]!.values.total_shopify_orders, w.sent[0]!.values.total_revenue], ["204", "1,27,581.05"], "what was sent IS what was stored");
    });
  });

  it("a retry after the live numbers moved on resends the SAVED figures and does not read Shopify again", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, { recipients: [{ name: "Owner", phone: A }], need });
      w.live.current = SHOPIFY;
      w.refuse.add(A);
      await w.svc.runDue();
      const row = await tx.reportDeliveryRecipient.findFirstOrThrow({ where: { phone: A } });
      assert.equal(row.status, "FAILED");
      w.live.current = { ...SHOPIFY, shopify: { totalOrders: 230, websiteOrders: 130, telecallerOrders: 100, totalRevenue: 150000 } }; // the afternoon
      w.refuse.delete(A);
      await w.svc.retryRecipient(w.actor as never, row.id, "TEXT");
      assert.deepEqual([w.sent[0]!.values.total_shopify_orders, w.sent[0]!.values.website_orders, w.sent[0]!.values.telecaller_orders, w.sent[0]!.values.total_revenue], ["204", "120", "84", "1,27,581.05"]);
      assert.equal(w.live.calls, 1);
    });
  });

  it("history is immutable: the next day's report is its own snapshot and yesterday's never changes", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, { need });
      w.live.current = SHOPIFY;
      await w.svc.runDue();
      w.live.current = { ...SHOPIFY, shopify: { totalOrders: 90, websiteOrders: 60, telecallerOrders: 30, totalRevenue: 40000.5 } };
      w.clock.now = new Date("2026-11-20T03:30:00Z");
      await w.svc.runDue();
      const h = await w.svc.snapshots(w.actor as never, 1, 10);
      assert.deepEqual(h.items.map((i) => [i.reportDate, i.values.total_shopify_orders, i.values.total_revenue]), [["2026-11-19", "90", "40,000.50"], ["2026-11-18", "204", "1,27,581.05"]]);
      assert.equal((h.items[1]!.figures as unknown as { shopify: { telecallerOrders: number } }).shopify.telecallerOrders, 84);
    });
  });

  it("if the Shopify set could not be read, the message carries N/A and is NOT frozen; a later retry reads it and freezes the complete figures", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, { recipients: [{ name: "Owner", phone: A }], need });
      w.live.current = { ...SHOPIFY, shopify: null };
      w.refuse.add(A);
      await w.svc.runDue();
      assert.equal((await snapshotsOf(tx, w.admin.id)).length, 0);
      w.live.current = SHOPIFY;
      w.refuse.delete(A);
      const row = await tx.reportDeliveryRecipient.findFirstOrThrow({ where: { phone: A } });
      await w.svc.retryRecipient(w.actor as never, row.id, "TEXT");
      assert.equal(w.sent[0]!.values.total_shopify_orders, "204");
      assert.equal((await snapshotsOf(tx, w.admin.id)).length, 1);
    });
  });

  it("the original website + abandoned template is unaffected: it still freezes only when BOTH of its sections were read", async () => {
    await inRollback(async (tx) => {
      const w = await harness(tx, { need: { legacy: true } });
      w.live.current = SHOPIFY; // abandoned missing
      await w.svc.runDue();
      assert.equal((await snapshotsOf(tx, w.admin.id)).length, 0);
    });
  });
});
