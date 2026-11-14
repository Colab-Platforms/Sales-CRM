// Fastrr recovery against the real schema. ISOLATED database only (run-iso.ps1 refuses anything but crm_iso). Every test runs inside ONE transaction that is always rolled back; the Fastrr API is a mock.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "../../lib/prisma.js";
import { AbandonmentType, ActivitySource, ActivityType, CallDirection, CallStatus, Role, WebhookStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ApiError } from "../../utils/apiError.js";
import { PrismaExcelSource } from "../abandonment/recording-export.sources.js";
import { EXCEL_COLUMNS, excelCell } from "../abandonment/recording-export.excel.js";
import { loadFastrrRecoveryConfig } from "./fastrr-recovery.config.js";
import { FastrrRecoveryService } from "./fastrr-recovery.service.js";

class Rollback extends Error {}
type Tx = Prisma.TransactionClient;
async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
before(async () => {
  const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>("select current_database()::text as db");
  if (db !== "crm_iso") throw new Error(`GUARD: these tests only run against crm_iso (got ${db})`);
});
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const config = () => loadFastrrRecoveryConfig({ FASTRR_REPORTING_AUTH_TOKEN: "fake-token", FASTRR_REPORTING_AUTH_INFO: "fake-info" });
const NOW = new Date("2026-11-14T06:00:00.000Z");
let phoneSeq = 0;
const phone = () => `9${String(7_000_000 + ((Date.now() + phoneSeq++) % 2_000_000)).padStart(9, "0")}`; // 10 digits, unique per call

const cart = (id: string, over: Record<string, unknown> = {}) => ({
  cart: id, custName: "Recovered Customer", custPhone: phone(), custEmail: null, timeInitiated: "2026-11-14T01:30:00", amount: 549, subTotal: 599, checkoutStage: "ORDER_SCREEN", latestStage: "PAYMENT_INITIATED",
  orderId: null, shippingCharges: 0, codCharges: 0, couponDiscount: 0, notificationTime: null,
  items: [{ name: "Hair Oil", sku: "HO-1", quantity: 1, price: 549 }], ...over,
});

const ok = (carts: unknown[]) => () => new Response(JSON.stringify({ data: { abandonCarts: carts } }), { status: 200 });
/** A fresh mocked feed per fetch, so the service can analyse more than once (preview, import, retry). */
const feedAlways = (carts: unknown[]) => {
  let page = 0;
  return (async () => (page++ % 2 === 0 ? ok(carts)() : ok([])())) as unknown as typeof fetch;
};

/** The test transaction as the service's database; $transaction reuses it, and can be told to fail specific calls (a simulated database error). */
function dbOver(tx: Tx, failCalls: Set<number> = new Set()) {
  let n = 0;
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "$transaction") {
        return async (fn: (t: Tx) => Promise<unknown>) => {
          n += 1;
          if (failCalls.has(n)) throw new Error("simulated database failure");
          return fn(tx);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as never;
}
const serviceOver = (tx: Tx, carts: unknown[], failCalls?: Set<number>, extra: { maxPages?: number } = {}) =>
  new FastrrRecoveryService({ db: dbOver(tx, failCalls), config, now: () => NOW, concurrency: 1, fetchOptions: { fetchImpl: feedAlways(carts), sleep: async () => undefined, ...extra } });

async function admin(tx: Tx) {
  return tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
}
const abandonmentsFor = (tx: Tx, ids: string[]) => tx.abandonment.findMany({ where: { referenceId: { in: ids } }, include: { lead: true } });

describe("preview classification (real DB)", () => {
  it("counts existing (abandonment or webhook), missing, duplicate, invalid and converted - and writes nothing", async () => {
    await inRollback(async (tx) => {
      const t = uid().slice(0, 8);
      const holder = await tx.lead.create({ data: { leadNumber: `L-${t}`, firstName: "Holder", mobile: "+919000000001", normalizedMobile: "+919000000001" } });
      await tx.abandonment.create({ data: { leadId: holder.id, type: AbandonmentType.CHECKOUT, referenceId: `${t}-in-crm`, detectedAt: new Date(), status: "RECOVERED" } });
      await tx.webhookEvent.create({ data: { provider: "SHIPROCKET_CHECKOUT", eventType: "checkout.abandoned", externalEventId: uid(), payload: { cart_id: `${t}-via-webhook` }, status: WebhookStatus.PROCESSED, receivedAt: new Date() } });
      await tx.webhookEvent.create({ data: { provider: "SHIPROCKET_CHECKOUT", eventType: "checkout.abandoned", externalEventId: uid(), payload: { cart_id: `${t}-ignored` }, status: WebhookStatus.IGNORED, receivedAt: new Date() } });
      const records = [
        cart(`${t}-in-crm`), cart(`${t}-via-webhook`), cart(`${t}-ignored`), cart(`${t}-new`), cart(`${t}-new`, { timeInitiated: "2026-11-14T02:00:00" }),
        cart(`${t}-bad`, { custPhone: null, custEmail: null }), cart(`${t}-ordered`, { orderId: "ORD-1" }),
      ];
      const before = await tx.abandonment.count();
      const svc = serviceOver(tx, records);
      const p = await svc.preview("2026-11-14", "2026-11-14");
      assert.deepEqual(p.counts, { fetched: 7, existing: 2, missing: 2, duplicates: 1, invalid: 1, converted: 1 });
      assert.equal(p.counts.existing + p.counts.missing + p.counts.duplicates + p.counts.invalid + p.counts.converted, p.counts.fetched, "every record lands in exactly one bucket");
      assert.ok(p.sampleMissing.every((s) => !/^\d{10}$/.test(String(s.phone))), "phones are masked in the preview");
      assert.equal(await tx.abandonment.count(), before, "a preview writes nothing");
      const withOrders = await svc.preview("2026-11-14", "2026-11-14", { includeConverted: true });
      assert.equal(withOrders.counts.missing, 3);
    });
  });
});

describe("import (real DB)", () => {
  it("creates the lead + abandonment through the normal save step, keeps the cart id and address, never assigns, and a repeat finds nothing", async () => {
    await inRollback(async (tx) => {
      const t = uid().slice(0, 8);
      const user = await admin(tx);
      const records = [cart(`${t}-a`, { shippingAddress: { address1: "12 MG Road", address2: "Flat 4", landmark: "Metro", city: "Pune", state: "MH", pincode: "411001", country: "India" } }), cart(`${t}-b`), cart(`${t}-c`, { custPhone: null, custEmail: `${t}@example.test` })];
      const svc = serviceOver(tx, records);
      const { run, done } = await svc.startImport(user, { from: "2026-11-14", to: "2026-11-14", expectedMissing: 3 });
      assert.equal(run.status, "RUNNING");
      await done;
      const finished = await svc.getRun(run.id);
      assert.deepEqual({ s: finished.status, imported: finished.imported, merged: finished.merged, failed: finished.failed, missing: finished.missing }, { s: "COMPLETED", imported: 3, merged: 0, failed: 0, missing: 3 });
      assert.ok(finished.finishedAt);

      const rows = await abandonmentsFor(tx, [`${t}-a`, `${t}-b`, `${t}-c`]);
      assert.equal(rows.length, 3);
      const a = rows.find((r) => r.referenceId === `${t}-a`)!;
      assert.equal(a.type, AbandonmentType.CHECKOUT);
      assert.equal(a.referenceType, "FastrrRecoveryCart");
      assert.equal(a.detectedAt.toISOString(), "2026-11-13T20:00:00.000Z", "the original checkout time, not the import time");
      assert.equal(a.status, "ACTIVE");
      const snap = a.cartSnapshot as Record<string, any>;
      assert.equal(snap.cartValue, "549");
      assert.equal(snap.shippingAddress.city, "Pune");
      assert.equal(snap.shippingAddress.line2, "Flat 4");
      assert.equal(snap.shippingAddressText, "12 MG Road, Flat 4, Metro, Pune, MH, 411001, India");
      assert.equal(a.lead.ownerId, null, "never auto-assigned");
      assert.equal(a.lead.assignedManagerId, null);
      const acts = await tx.activity.findMany({ where: { leadId: a.leadId, type: ActivityType.ABANDONMENT } });
      assert.equal(acts.length, 1);
      assert.equal(acts[0]!.source, ActivitySource.SYSTEM);

      // repeat: nothing is left to import, nothing is duplicated
      const total = await tx.abandonment.count({ where: { referenceId: { in: [`${t}-a`, `${t}-b`, `${t}-c`] } } });
      const again = await svc.startImport(user, { from: "2026-11-14", to: "2026-11-14" });
      await again.done;
      assert.deepEqual({ s: again.run.status, missing: again.run.missing, existing: again.run.existing, imported: again.run.imported }, { s: "COMPLETED", missing: 0, existing: 3, imported: 0 });
      assert.equal(await tx.abandonment.count({ where: { referenceId: { in: [`${t}-a`, `${t}-b`, `${t}-c`] } } }), total);
    });
  });

  it("an existing lead keeps its assignment, status, name, email, calls and notes; a recovered OLD cart never moves lastActivityAt back", async () => {
    await inRollback(async (tx) => {
      const t = uid().slice(0, 8);
      const user = await admin(tx);
      const manager = await tx.user.create({ data: { name: "Manager", username: `m-${uid()}`, role: Role.MANAGER } });
      const tele = await tx.user.create({ data: { name: "Tele", username: `t-${uid()}`, role: Role.SALESPERSON } });
      const mobile = "+919811112222";
      const lastActivityAt = new Date("2026-11-14T05:00:00.000Z");
      const lead = await tx.lead.create({ data: { leadNumber: `L-${t}`, firstName: "Existing", lastName: "Name", mobile, normalizedMobile: mobile, email: "keep@example.test", normalizedEmail: "keep@example.test", ownerId: tele.id, assignedManagerId: manager.id, workingStatus: "INTERESTED", lastActivityAt } });
      await tx.call.create({ data: { leadId: lead.id, agentId: tele.id, provider: "test", direction: CallDirection.OUTBOUND, status: CallStatus.COMPLETED } });
      await tx.activity.create({ data: { leadId: lead.id, type: ActivityType.NOTE, source: ActivitySource.USER, title: "Note", description: "Customer asked for a call back" } });
      const snapshot = async () => ({ lead: await tx.lead.findUniqueOrThrow({ where: { id: lead.id } }), calls: await tx.call.count({ where: { leadId: lead.id } }), notes: await tx.activity.count({ where: { leadId: lead.id, type: ActivityType.NOTE } }) });
      const before = await snapshot();

      // Fastrr's record has a different name, no email, and an older checkout time than the lead's last activity.
      const svc = serviceOver(tx, [cart(`${t}-old`, { custName: "Totally Different", custPhone: "9811112222", custEmail: "", timeInitiated: "2026-11-14T08:00:00" })]);
      const { done } = await svc.startImport(user, { from: "2026-11-14", to: "2026-11-14" });
      await done;

      const after = await snapshot();
      assert.deepEqual(after.lead, before.lead, "the lead row is untouched: name, email, owner, manager, status, lastActivityAt");
      assert.equal(after.calls, 1);
      assert.equal(after.notes, 1);
      const [row] = await abandonmentsFor(tx, [`${t}-old`]);
      assert.equal(row!.leadId, lead.id, "the cart attaches to the existing person (matched on the normalised phone)");
      assert.equal(await tx.lead.count({ where: { normalizedMobile: mobile } }), 1, "no second lead");
    });
  });

  it("an import that fails part-way records the failure with the cart id (no personal data), and the retry imports only what is missing", async () => {
    await inRollback(async (tx) => {
      const t = uid().slice(0, 8);
      const user = await admin(tx);
      const ids = [`${t}-1`, `${t}-2`, `${t}-3`];
      const records = ids.map((id) => cart(id));
      // $transaction call 1 is the run-lock transaction, call 2 is the first cart's save: that one fails.
      const failing = serviceOver(tx, records, new Set([2]));
      const first = await failing.startImport(user, { from: "2026-11-14", to: "2026-11-14" });
      await first.done;
      const partial = await failing.getRun(first.run.id);
      assert.deepEqual({ s: partial.status, imported: partial.imported, failed: partial.failed }, { s: "PARTIAL", imported: 2, failed: 1 });
      const errors = partial.errors as { cartId: string; reason: string }[];
      assert.equal(errors.length, 1);
      assert.equal(errors[0]!.cartId, ids[0]);
      assert.ok(!JSON.stringify(errors).match(/\d{10}/), "the error list carries no phone number");
      assert.equal((await abandonmentsFor(tx, ids)).length, 2);

      const healthy = serviceOver(tx, records);
      const retry = await healthy.retryRun(user, partial.id);
      await retry.done;
      const done = await healthy.getRun(retry.run.id);
      assert.deepEqual({ s: done.status, imported: done.imported, missing: done.missing, retryOf: done.retryOfId }, { s: "COMPLETED", imported: 1, missing: 1, retryOf: partial.id });
      assert.equal((await abandonmentsFor(tx, ids)).length, 3, "all three now exist, none twice");
      await assert.rejects(healthy.retryRun(user, done.id), (e: unknown) => e instanceof ApiError && e.statusCode === 409, "a completed run cannot be retried");
    });
  });
});

describe("import safeguards (real DB)", () => {
  it("is refused when the data changed since the preview, when Fastrr's list is incomplete, and while another import is running", async () => {
    await inRollback(async (tx) => {
      const t = uid().slice(0, 8);
      const user = await admin(tx);
      const records = [cart(`${t}-1`), cart(`${t}-2`)];
      const svc = serviceOver(tx, records);
      const runsBefore = await tx.fastrrRecoveryRun.count();

      await assert.rejects(svc.startImport(user, { from: "2026-11-14", to: "2026-11-14", expectedMissing: 5 }), (e: unknown) => e instanceof ApiError && e.statusCode === 409 && /Preview again/.test(e.message));

      let n = 0;
      const endless = new FastrrRecoveryService({ db: dbOver(tx), config, now: () => NOW, concurrency: 1, fetchOptions: { fetchImpl: (async () => ok([cart(`${t}-e${n++}`)])()) as unknown as typeof fetch, sleep: async () => undefined, maxPages: 2 } });
      await assert.rejects(endless.startImport(user, { from: "2026-11-14", to: "2026-11-14" }), (e: unknown) => e instanceof ApiError && e.statusCode === 409 && /incomplete/i.test(e.message));
      assert.equal(await tx.fastrrRecoveryRun.count(), runsBefore, "nothing was recorded or imported");

      const running = await tx.fastrrRecoveryRun.create({ data: { createdById: user.id, fromDay: "2026-11-14", toDay: "2026-11-14", status: "RUNNING" } });
      await assert.rejects(svc.startImport(user, { from: "2026-11-14", to: "2026-11-14" }), (e: unknown) => e instanceof ApiError && e.statusCode === 409 && /still running/.test(e.message));

      // a run that stopped ticking long ago is marked failed (retryable) and no longer blocks
      await tx.fastrrRecoveryRun.update({ where: { id: running.id }, data: { updatedAt: new Date(NOW.getTime() - 60 * 60_000) } });
      const next = await svc.startImport(user, { from: "2026-11-14", to: "2026-11-14" });
      await next.done;
      assert.equal((await svc.getRun(running.id)).status, "FAILED");
      assert.equal((await svc.getRun(next.run.id)).imported, 2);
    });
  });

  it("an authentication failure writes nothing and says how to fix it", async () => {
    await inRollback(async (tx) => {
      const user = await admin(tx);
      const svc = new FastrrRecoveryService({ db: dbOver(tx), config, now: () => NOW, fetchOptions: { fetchImpl: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch, sleep: async () => undefined } });
      const before = { a: await tx.abandonment.count(), r: await tx.fastrrRecoveryRun.count() };
      await assert.rejects(svc.startImport(user, { from: "2026-11-14", to: "2026-11-14" }), (e: unknown) => e instanceof ApiError && e.statusCode === 502 && /credentials/.test(e.message));
      assert.deepEqual({ a: await tx.abandonment.count(), r: await tx.fastrrRecoveryRun.count() }, before);
    });
  });
});

describe("Abandoned Leads Excel: shipping address columns (real DB)", () => {
  it("complete, partial and missing addresses export correctly, next to name / phone / email", async () => {
    await inRollback(async (tx) => {
      const t = uid().slice(0, 8);
      const user = await admin(tx);
      const mk = async (n: number, snapshot: Record<string, unknown>) => {
        const mobile = `+9198${t.replace(/\D/g, "0").slice(0, 4).padEnd(4, "0")}${String(1000 + n)}`;
        const lead = await tx.lead.create({ data: { leadNumber: `X-${t}-${n}`, firstName: `Cust${n}`, mobile, normalizedMobile: mobile, email: `c${n}-${t}@example.test` } });
        await tx.abandonment.create({ data: { leadId: lead.id, type: AbandonmentType.CHECKOUT, detectedAt: new Date(), cartSnapshot: { currency: "INR", itemNames: ["X"], ...snapshot } as Prisma.InputJsonValue } });
        return lead.leadNumber;
      };
      const complete = await mk(1, { shippingAddress: { line1: "12 MG Road", line2: "Flat 4", landmark: "Metro", city: "Pune", state: "MH", pincode: "411001", country: "India" } });
      const partial = await mk(2, { shippingAddress: { city: "Pune", pincode: "411001" } });
      const none = await mk(3, {});
      const original = await mk(4, { shippingAddress: { city: "Pune" }, shippingAddressText: "Original text as typed" });

      const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
      const source = new PrismaExcelSource(tx as never, { id: user.id, role: Role.ADMIN, username: user.username } as never, { from: day, to: day }, null);
      const rows: any[] = [];
      for await (const page of source.pages()) rows.push(...page);
      const by = (lead: string) => rows.find((r) => r.leadNumber === lead)!;

      const c = by(complete);
      assert.deepEqual([c.addressLine1, c.addressLine2, c.landmark, c.city, c.state, c.pincode, c.country, c.fullShippingAddress], ["12 MG Road", "Flat 4", "Metro", "Pune", "MH", "411001", "India", "12 MG Road, Flat 4, Metro, Pune, MH, 411001, India"]);
      const p = by(partial);
      assert.deepEqual([p.addressLine1, p.city, p.state, p.pincode, p.fullShippingAddress], ["", "Pune", "", "411001", "Pune, 411001"]);
      const n = by(none);
      assert.deepEqual([n.addressLine1, n.city, n.pincode, n.fullShippingAddress], ["", "", "", ""]);
      assert.equal(by(original).fullShippingAddress, "Original text as typed");

      // the sheet columns: name, phone, email, then the address columns, then the original columns unchanged
      const headers = EXCEL_COLUMNS.map((x) => x.header);
      assert.deepEqual(headers.slice(1, 12), ["Customer name", "Contact number", "Email", "Address Line 1", "Address Line 2", "Landmark", "City", "State", "Pincode", "Country", "Full Shipping Address"]);
      assert.ok(headers.includes("Recording available") && headers.includes("Latest order"), "existing columns are kept");
      const cells = EXCEL_COLUMNS.map((col) => excelCell(c, col.key));
      assert.equal(cells[headers.indexOf("City")], "Pune");
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet("t");
      sheet.addRow(headers);
      sheet.addRow(cells);
      assert.equal(sheet.getRow(2).getCell(headers.indexOf("Pincode") + 1).value, "411001");
    });
  });
});
