// Abandoned Checkouts dashboard against the real schema, ISOLATED test database only (one rolled-back transaction per test; the route test only makes refused / read-only requests).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import ExcelJS from "exceljs";
import type { AddressInfo } from "node:net";
import { prisma } from "../../lib/prisma.js";
import { signToken } from "../../lib/jwt.js";
import { errorHandler } from "../../middlewares/errorHandler.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import AbandonedDashboardService, { ABANDONED_METRICS, type AbandonedFilters, type AbandonedMetric } from "./abandoned.dashboard.service.js";
import OrdersDashboardService from "./orders.dashboard.service.js";
import ordersDashboardRoutes from "./orders.dashboard.routes.js";

if (!/127\.0\.0\.1:5544\/crm_iso$/.test(process.env.DATABASE_URL ?? "")) throw new Error("GUARD: this test only runs against the isolated database");

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID().slice(0, 8);
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-26T06:00:00Z"); // yesterday = 25 Oct IST = [24 Oct 18:30Z, 25 Oct 18:30Z)
const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });

async function world(tx: Prisma.TransactionClient) {
  const tag = uid();
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${tag}`, role: Role.ADMIN } });
  const manager = await tx.user.create({ data: { name: "Manager One", username: `m1-${tag}`, role: Role.MANAGER } });
  const other = await tx.user.create({ data: { name: "Manager Two", username: `m2-${tag}`, role: Role.MANAGER } });
  const caller = await tx.user.create({ data: { name: "Asha Caller", username: `s-${tag}`, role: Role.SALESPERSON } });
  let n = 0;
  const lead = (first: string, mobile: string, managerId: string | null) => tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: first, lastName: "Buyer", mobile, normalizedMobile: `+91${mobile}`, email: `${first.toLowerCase()}@example.test`, assignedManagerId: managerId, ownerId: caller.id } });
  const mk = async (key: string, o: { detectedAt: string; status?: "ACTIVE" | "IN_PROGRESS" | "RECOVERED" | "NOT_RECOVERED" | "EXPIRED"; type?: "CHECKOUT" | "PAYMENT"; value?: string; currency?: string; managerId?: string | null; action?: "SUCCESS" | "FAILED" | "PENDING" | "IN_PROGRESS" }) => {
    n++;
    const l = await lead(key, `90000000${String(n).padStart(2, "0")}`, o.managerId === undefined ? manager.id : o.managerId);
    const a = await tx.abandonment.create({
      data: {
        leadId: l.id,
        type: o.type ?? "CHECKOUT",
        status: o.status ?? "ACTIVE",
        detectedAt: at(o.detectedAt),
        cartSnapshot: { cartValue: o.value ?? null, currency: o.currency ?? "INR", itemCount: 2, itemNames: ["Herbal Oil", "Masala"], items: [], stage: "PAYMENT", checkoutUrl: `https://shop.example.test/checkouts/${key}` },
      },
    });
    if (o.action) await tx.recoveryAction.create({ data: { abandonmentId: a.id, leadId: l.id, type: "CALL", status: o.action, performedById: caller.id } });
    return { a, l };
  };
  // ---- fixture (yesterday = 25 Oct IST)
  const A1 = await mk("A1", { detectedAt: "2026-10-25T10:00:00Z", value: "1000.00" }); // open, no follow-up
  const A2 = await mk("A2", { detectedAt: "2026-10-25T11:00:00Z", status: "IN_PROGRESS", value: "500.00", action: "FAILED" }); // open, follow-up finished
  const A3 = await mk("A3", { detectedAt: "2026-10-25T12:00:00Z", status: "RECOVERED", value: "300.00", action: "SUCCESS" }); // purchase completed
  const A4 = await mk("A4", { detectedAt: "2026-10-25T13:00:00Z", status: "NOT_RECOVERED", value: "200.00" }); // lost, no follow-up
  const A5 = await mk("A5", { detectedAt: "2026-10-25T14:00:00Z", value: "not-a-number" }); // open, no usable value
  const A6 = await mk("A6", { detectedAt: "2026-10-25T15:00:00Z", value: "99.00", currency: "USD" }); // open, other currency
  const A7 = await mk("A7", { detectedAt: "2026-10-24T18:29:59.999Z", value: "70.00" }); // 1 ms before yesterday
  const A8 = await mk("A8", { detectedAt: "2026-10-25T18:30:00.000Z", value: "80.00" }); // exactly the end -> today
  const A9 = await mk("A9", { detectedAt: "2026-10-25T09:00:00Z", type: "PAYMENT", value: "60.00" }); // not a checkout
  const A10 = await mk("A10", { detectedAt: "2026-10-25T16:00:00Z", value: "50.00", managerId: other.id, action: "PENDING" }); // another manager's customer; its only follow-up is still pending
  const svc = new AbandonedDashboardService(tx, () => NOW);
  return { admin, manager, other, caller, A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, svc, as: (u: typeof admin, r: Role) => as(u, r) };
}
type World = Awaited<ReturnType<typeof world>>;
const ids = (items: { id: string }[]) => items.map((i) => i.id).sort();
const aid = (...rows: { a: { id: string } }[]) => rows.map((r) => r.a.id).sort();
const detail = async (w: World, f: AbandonedFilters & { page?: number; pageSize?: number }, role: Role = Role.ADMIN) => {
  const { page = 1, pageSize = 100, ...rest } = f;
  const user = role === Role.MANAGER ? w.as(w.manager, Role.MANAGER) : w.as(w.admin, Role.ADMIN);
  const r = await w.svc.overview(user, rest, page, pageSize);
  assert.ok(r.details);
  return { ...r, ...r.details! };
};

describe("access", () => {
  it("telecallers, HR, recruiters and anonymous users are refused on the routes and in the service; Admin and Manager are let in", async () => {
    const app = express();
    app.use("/api/orders-dashboard", ordersDashboardRoutes);
    app.use(errorHandler);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/orders-dashboard`;
      const call = (path: string, token?: string) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      const token = (role: Role) => signToken({ sub: randomUUID(), role, username: "x" } as never);
      for (const role of [Role.SALESPERSON, Role.HR, Role.RECRUITER]) {
        assert.equal((await call("/abandoned", token(role))).status, 403, role);
        assert.equal((await call("/abandoned/export", token(role))).status, 403, `${role} export`);
      }
      assert.equal((await call("/abandoned")).status, 401);
      for (const role of [Role.ADMIN, Role.MANAGER]) {
        assert.equal((await call("/abandoned", token(role))).status, 200, role);
        assert.equal((await call("/abandoned?metric=PENDING", token(role))).status, 200);
        assert.equal((await call("/abandoned?metric=PAID", token(role))).status, 400, "PAID is a website-order card, not an abandoned-checkout one");
        assert.equal((await call("/abandoned?range=custom&from=2026-10-22&to=2026-10-20", token(role))).status, 400);
        const x = await call("/abandoned/export", token(role));
        assert.equal(x.status, 200);
        assert.match(x.headers.get("content-type") ?? "", /spreadsheetml/);
      }
    } finally {
      server.close();
    }
    await inRollback(async (tx) => {
      const w = await world(tx);
      for (const role of [Role.SALESPERSON, Role.HR, Role.RECRUITER]) {
        await assert.rejects(() => w.svc.overview(w.as(w.caller, role), { metric: "TOTAL" }, 1, 10), /Forbidden/);
        await assert.rejects(() => w.svc.exportXlsx(w.as(w.caller, role), {}), /Forbidden/);
      }
    });
  });
});

describe("cards", () => {
  it("count only real abandoned checkouts of the selected day: a recovered cart, another type, and carts just outside the day are not counted; the value is the open carts' numeric INR value", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.svc.overview(w.as(w.admin, Role.ADMIN), {}, 1, 25);
      assert.equal(r.details, null, "no card clicked: no rows");
      assert.deepEqual([r.range.kind, r.range.from], ["yesterday", "2026-10-25"]);
      assert.deepEqual(r.summary, {
        totalAbandoned: 6, // A1 A2 A4 A5 A6 A10 (not A3 recovered, A7/A8 outside the day, A9 another type)
        potentialValue: 1550, // open carts: A1 1000 + A2 500 + A10 50 (A5 has no number, A6 is USD, A4 is lost)
        openCheckouts: 5,
        followUpPending: 5, // A1 A4 A5 A6 A10 (A10's only action is still PENDING)
        followUpCompleted: 1, // A2
        recovered: 1, // A3
        detected: 7, // A1 A2 A3 A4 A5 A6 A10: every checkout of the day, recovered ones included
        conversion: { converted: 0, conversionRate: 0, revenue: 0, prepaid: { count: 0, revenue: 0 }, cod: { count: 0, revenue: 0 }, awaitingPayment: 0, unclassified: 0, byTelecaller: [] },
        openWithoutValue: 1,
        openOtherCurrency: 1,
      });
      assert.equal(r.source.paymentModeAvailable, false, "the abandonment event itself carries no payment mode (COD / prepaid come from the linked order)");
    });
  });

  it("every card's rows are exactly the checkouts behind its number", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { summary } = await w.svc.overview(w.as(w.admin, Role.ADMIN), {}, 1, 25);
      const expected: Record<AbandonedMetric, { ids: string[]; count: number }> = {
        TOTAL: { ids: aid(w.A1, w.A2, w.A4, w.A5, w.A6, w.A10), count: summary.totalAbandoned },
        VALUE: { ids: aid(w.A1, w.A2, w.A5, w.A6, w.A10), count: summary.openCheckouts },
        PENDING: { ids: aid(w.A1, w.A4, w.A5, w.A6, w.A10), count: summary.followUpPending },
        DONE: { ids: aid(w.A2), count: summary.followUpCompleted },
        RECOVERED: { ids: aid(w.A3), count: summary.recovered },
        CONVERTED: { ids: [], count: summary.conversion.converted }, // nothing converted in this fixture
        DETECTED: { ids: aid(w.A1, w.A2, w.A3, w.A4, w.A5, w.A6, w.A10), count: summary.detected },
        COD: { ids: [], count: summary.conversion.cod.count },
        PREPAID: { ids: [], count: summary.conversion.prepaid.count },
      };
      for (const metric of ABANDONED_METRICS) {
        const d = await detail(w, { metric });
        assert.deepEqual(ids(d.items), expected[metric].ids, metric);
        assert.equal(d.pagination.totalItems, expected[metric].count, `${metric}: the card number equals the rows`);
      }
      // pending + completed partition the not-recovered total
      assert.equal(summary.followUpPending + summary.followUpCompleted, summary.totalAbandoned);
      // the open rows add up to the value card (numeric INR carts only)
      const open = await detail(w, { metric: "VALUE" });
      assert.equal(open.items.filter((i) => i.currency === "INR" && i.amount !== null).reduce((s, i) => s + (i.amount ?? 0), 0), summary.potentialValue);
    });
  });

  it("the date range is by checkout time in IST: today, yesterday, a custom range; the cards and the rows follow it together", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      const today = await detail(w, { metric: "TOTAL", range: "today" });
      assert.deepEqual(ids(today.items), aid(w.A8));
      assert.equal(today.summary.totalAbandoned, 1);
      const wide = await detail(w, { metric: "TOTAL", range: "custom", from: "2026-10-24", to: "2026-10-26" });
      assert.deepEqual(ids(wide.items), aid(w.A1, w.A2, w.A4, w.A5, w.A6, w.A7, w.A8, w.A10));
      assert.equal(wide.summary.totalAbandoned, 8);
      await assert.rejects(() => w.svc.overview(a, { range: "custom", from: "2026-10-26", to: "2026-10-25" }, 1, 10), /From date must be on or before/);
      assert.equal((await w.svc.overview(a, { range: "custom", from: "2026-01-01", to: "2026-01-02" }, 1, 10)).summary.totalAbandoned, 0, "an empty range is simply zero");
    });
  });
});

describe("rows, visibility, search, pagination and export", () => {
  it("each row shows the customer's contact, checkout date, amount, checkout link and follow-up status; nothing is made up", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const d = await detail(w, { metric: "TOTAL" });
      const a2 = d.items.find((i) => i.id === w.A2.a.id)!;
      assert.deepEqual([a2.customerName, a2.phone?.length, a2.email, a2.amount, a2.currency, a2.followUp, a2.status], ["A2 Buyer", 10, "a2@example.test", 500, "INR", "DONE", "IN_PROGRESS"]);
      assert.equal(a2.checkoutLink, "https://shop.example.test/checkouts/A2");
      assert.deepEqual(a2.lastAction && [a2.lastAction.type, a2.lastAction.status], ["CALL", "FAILED"]);
      const a5 = d.items.find((i) => i.id === w.A5.a.id)!;
      assert.equal(a5.amount, null, "a cart without a usable value shows no amount");
      assert.equal(d.items.find((i) => i.id === w.A1.a.id)!.followUp, "PENDING");
      assert.equal((await detail(w, { metric: "RECOVERED" })).items[0]!.followUp, "RECOVERED");
    });
  });

  it("a Manager sees only the checkouts assigned to them (the existing abandoned-lead rule); an Admin sees all", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const mgr = await detail(w, { metric: "TOTAL" }, Role.MANAGER);
      assert.deepEqual(ids(mgr.items), aid(w.A1, w.A2, w.A4, w.A5, w.A6), "A10 belongs to another manager");
      assert.equal(mgr.summary.totalAbandoned, 5);
      assert.equal(mgr.summary.potentialValue, 1500, "the value excludes the other manager's cart too");
      assert.equal((await detail(w, { metric: "TOTAL" })).summary.totalAbandoned, 6);
    });
  });

  it("an order is never an abandoned checkout, and an abandoned checkout is never an order: creating completed orders changes no abandoned count and the website cards ignore abandoned rows", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const before = (await w.svc.overview(w.as(w.admin, Role.ADMIN), {}, 1, 25)).summary;
      await tx.order.create({ data: { orderNumber: `ORD-${uid()}`, leadId: w.A1.l.id, source: "SHOPIFY", status: "CONFIRMED", totalAmount: "1000.00", createdAt: at("2026-10-25T10:30:00Z"), externalSource: "SHOPIFY", externalId: `77${uid()}`, metadata: { paymentMode: "COD" } } });
      assert.deepEqual((await w.svc.overview(w.as(w.admin, Role.ADMIN), {}, 1, 25)).summary, before);
      const orders = new OrdersDashboardService(tx, () => NOW, async () => null);
      const site = await orders.overview(w.as(w.admin, Role.ADMIN), { scope: "WEBSITE" }, 1, 25);
      assert.equal(site.summary.totalOrders, 1, "only the real order is a website order");
    });
  });

  it("search (customer, phone, email), server-side pagination and the Excel export all follow the clicked card and the range", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      assert.deepEqual(ids((await detail(w, { metric: "TOTAL", search: "a2@example.test" })).items), aid(w.A2));
      assert.deepEqual(ids((await detail(w, { metric: "TOTAL", search: "A5 Buyer" })).items).includes(w.A5.a.id), true, "name search (every term must match)");
      assert.deepEqual(ids((await detail(w, { metric: "TOTAL", search: "a4@example.test" })).items), aid(w.A4));
      assert.equal((await detail(w, { metric: "TOTAL", search: "nobody-by-that-name" })).items.length, 0);
      assert.equal((await detail(w, { metric: "RECOVERED", search: "a1@example.test" })).items.length, 0, "the search stays inside the clicked card");
      const p1 = await detail(w, { metric: "TOTAL", page: 1, pageSize: 4 });
      const p2 = await detail(w, { metric: "TOTAL", page: 2, pageSize: 4 });
      assert.deepEqual([p1.items.length, p2.items.length, p1.pagination.totalItems, p1.pagination.totalPages], [4, 2, 6, 2]);
      assert.equal(new Set([...p1.items, ...p2.items].map((i) => i.id)).size, 6);
      assert.deepEqual(p1.summary, p2.summary);
      const dates = [...p1.items, ...p2.items].map((i) => +i.checkoutDate);
      assert.deepEqual(dates, [...dates].sort((x, y) => y - x));

      await tx.lead.update({ where: { id: w.A1.l.id }, data: { firstName: "=HYPERLINK(\"http://evil\")" } });
      const read = async (f: AbandonedFilters) => {
        const file = await w.svc.exportXlsx(w.as(w.admin, Role.ADMIN), f);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(file.buffer as never);
        const rows: string[] = [];
        wb.getWorksheet("Abandoned checkouts")!.eachRow((r, i) => { if (i > 1) rows.push(String(r.getCell(2).value)); });
        const summary = new Map<string, unknown>();
        wb.getWorksheet("Summary")!.eachRow((r) => summary.set(String(r.getCell(1).value), r.getCell(2).value));
        return { file, rows, summary };
      };
      const all = await read({});
      assert.equal(all.rows.length, 6);
      assert.ok(all.rows.some((c) => c.startsWith("'=")), "a formula-like name is stored as text");
      assert.equal(all.file.filename, "Abandoned_Checkouts_total_2026-10-25.xlsx");
      assert.deepEqual([all.summary.get("Total abandoned checkouts"), all.summary.get("Date range (by checkout time)")], [6, "2026-10-25"]);
      assert.equal((await read({ metric: "DONE" })).rows.length, 1);
      assert.equal((await read({ metric: "RECOVERED" })).file.filename, "Abandoned_Checkouts_recovered_2026-10-25.xlsx");
      assert.equal((await read({ metric: "TOTAL", range: "custom", from: "2026-10-24", to: "2026-10-26" })).rows.length, 8);
      assert.equal((await read({ metric: "TOTAL", range: "custom", from: "2026-01-01", to: "2026-01-02" })).rows.length, 0);
    });
  });
});

describe("abandoned-checkouts trend chart and coverage", () => {
  const RANGE = { range: "custom" as const, from: "2026-10-24", to: "2026-10-26" };

  it("daily buckets in IST add up to the cards for the same range (bars = Total Abandoned, line = Potential Value); recovered carts, other types and non-INR / non-numeric values are left out", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      const c = await w.svc.chart(a, RANGE, "daily");
      assert.deepEqual(c.buckets.map((b) => [b.key, b.abandoned, b.openValue]), [["2026-10-24", 1, 70], ["2026-10-25", 6, 1550], ["2026-10-26", 1, 80]]);
      const cards = (await w.svc.overview(a, RANGE, 1, 10)).summary;
      assert.deepEqual([c.totals.abandoned, c.totals.openValue], [cards.totalAbandoned, cards.potentialValue]);
      const weekly = await w.svc.chart(a, RANGE, "weekly");
      assert.deepEqual(weekly.buckets.map((b) => [b.key, b.abandoned, b.openValue]), [["2026-10-19", 7, 1620], ["2026-10-26", 1, 80]]);
      assert.deepEqual((await w.svc.chart(a, RANGE, "monthly")).buckets.map((b) => [b.key, b.abandoned]), [["2026-10-01", 8]]);
    });
  });

  it("days before the first checkout the CRM holds are UNAVAILABLE, not zero", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const gap = { range: "custom" as const, from: "2026-10-20", to: "2026-10-23" };
      const c = await w.svc.chart(w.as(w.admin, Role.ADMIN), gap, "daily");
      assert.equal(c.coverage, "NONE");
      assert.ok(c.buckets.every((b) => !b.available && b.abandoned === null && b.openValue === null));
      assert.equal((await w.svc.overview(w.as(w.admin, Role.ADMIN), gap, 1, 10)).coverage, "NONE");
    });
  });

  it("a Manager chart covers only their own assigned checkouts, like their cards", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const m = w.as(w.manager, Role.MANAGER);
      const c = await w.svc.chart(m, RANGE, "daily");
      assert.deepEqual(c.buckets.map((b) => [b.abandoned, b.openValue]), [[1, 70], [5, 1500], [1, 80]], "A10 belongs to the other manager");
      assert.equal(c.totals.abandoned, (await w.svc.overview(m, RANGE, 1, 10)).summary.totalAbandoned);
    });
  });

  it("the card comparison needs both periods fully covered", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      assert.equal((await w.svc.overview(a, {}, 1, 10)).comparison, null, "the day before the first checkout is not covered");
      await tx.abandonment.create({ data: { leadId: w.A1.l.id, type: "CHECKOUT", status: "ACTIVE", detectedAt: at("2026-10-01T10:00:00Z"), cartSnapshot: { cartValue: "10.00", currency: "INR" } } });
      const r = await w.svc.overview(a, {}, 1, 10);
      assert.equal(r.coverage, "FULL");
      assert.deepEqual(r.comparison?.totalAbandoned, { previous: 1, changePct: 500 }, "25 Oct: 6 vs 24 Oct: 1 (A7)");
    });
  });
});


// ------------------------------------------------------------------------------------------------ conversion & revenue (orders created from a checkout by a telecaller)
type Mode = "COD" | "PREPAID";
async function orderFor(tx: Prisma.TransactionClient, w: World, row: { a: { id: string }; l: { id: string } }, o: { total: string; mode?: Mode | null; pay?: "SUCCESS" | "PENDING" | "REFUNDED" | "PARTIALLY_REFUNDED" | null; status?: "CONFIRMED" | "CANCELLED" | "DRAFT" | "PENDING_PAYMENT" | "DELIVERED"; refunded?: string; link?: boolean; source?: "SALESPERSON" | "SHOPIFY"; by?: string; leadId?: string }) {
  const order = await tx.order.create({
    data: {
      orderNumber: `ORD-${uid()}`,
      leadId: o.leadId ?? row.l.id,
      createdById: o.by ?? w.caller.id,
      source: o.source ?? "SALESPERSON",
      status: o.status ?? "CONFIRMED",
      subtotal: o.total,
      totalAmount: o.total,
      metadata: { ...(o.mode === null ? {} : { paymentMode: o.mode ?? "COD" }), ...(o.link === false ? {} : { abandonment: { id: row.a.id, referenceId: null } }) },
    },
  });
  // payments are what the Reports rules read: COD = a COD payment row (pending until collected); prepaid = an online payment row in the given state; no row = no payment method yet
  if (o.mode === "COD") await tx.payment.create({ data: { orderId: order.id, amount: o.total, method: "COD", status: o.pay ?? "PENDING" } });
  else if (o.mode === "PREPAID" && o.pay) await tx.payment.create({ data: { orderId: order.id, amount: o.total, method: "UPI", status: o.pay, ...(o.refunded ? { refundedAmount: o.refunded } : {}) } });
  return order;
}
const conv = async (w: World, role: Role = Role.ADMIN) => (await w.svc.overview(role === Role.MANAGER ? w.as(w.manager, Role.MANAGER) : w.as(w.admin, Role.ADMIN), {}, 1, 25)).summary;

describe("conversion and revenue", () => {
  it("nothing converted: zero orders, zero revenue, a 0% rate over the checkouts detected (the same day's carts), no COD / prepaid", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const s = await conv(w);
      assert.equal(s.detected, 7); // A1 A2 A3 A4 A5 A6 A10 (A7/A8 outside the day, A9 is not a checkout)
      assert.deepEqual([s.conversion.converted, s.conversion.conversionRate, s.conversion.revenue, s.conversion.cod.count, s.conversion.prepaid.count], [0, 0, 0, 0, 0]);
    });
  });

  it("a COD order created from a checkout converts it: counted once, revenue = the order total, removed from the open cards and the potential value", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const before = await conv(w);
      await orderFor(tx, w, w.A1, { total: "1200.00", mode: "COD" });
      const s = await conv(w);
      assert.deepEqual([s.conversion.converted, s.conversion.cod, s.conversion.prepaid, s.conversion.revenue], [1, { count: 1, revenue: 1200 }, { count: 0, revenue: 0 }, 1200]);
      assert.equal(s.detected, before.detected, "total detected never changes");
      assert.equal(s.totalAbandoned, before.totalAbandoned - 1, "the converted checkout is no longer open");
      assert.equal(s.potentialValue, before.potentialValue - 1000, "its 1000 cart value leaves the potential value; the order's 1200 is revenue, not potential");
      assert.equal(s.openCheckouts, before.openCheckouts - 1);
      const rows = await detail(await Promise.resolve(w), { metric: "CONVERTED" });
      assert.deepEqual(ids(rows.items), aid(w.A1), "the Orders Converted rows are exactly the converted checkouts");
      assert.ok(!ids((await detail(w, { metric: "TOTAL" })).items).includes(w.A1.a.id), "never both open and converted");
    });
  });

  it("a prepaid order counts only with a verified (SUCCESS) payment; created-but-unpaid, pending or refunded prepaid is NOT a conversion and NOT revenue", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await orderFor(tx, w, w.A2, { total: "800.00", mode: "PREPAID", pay: "SUCCESS" });
      await orderFor(tx, w, w.A5, { total: "700.00", mode: "PREPAID", pay: "PENDING" });
      await orderFor(tx, w, w.A6, { total: "600.00", mode: "PREPAID", pay: null }); // no payment recorded at all
      await orderFor(tx, w, w.A4, { total: "500.00", mode: "PREPAID", pay: "REFUNDED", refunded: "500.00" }); // fully refunded: no longer a sale (Reports rule)
      const c = (await conv(w)).conversion;
      assert.deepEqual([c.converted, c.prepaid, c.revenue, c.awaitingPayment, c.unclassified], [1, { count: 1, revenue: 800 }, 800, 1, 1]);
      assert.ok(ids((await detail(w, { metric: "TOTAL" })).items).includes(w.A5.a.id), "an unpaid prepaid checkout is still open");
    });
  });

  it("cancelled and draft orders, orders with no recorded mode, website orders and unlinked orders are never conversions", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await orderFor(tx, w, w.A1, { total: "100.00", status: "CANCELLED" });
      await orderFor(tx, w, w.A2, { total: "100.00", status: "DRAFT" });
      await orderFor(tx, w, w.A5, { total: "100.00", mode: null }); // linked, but no payment mode
      await orderFor(tx, w, w.A6, { total: "100.00", link: false }); // same customer, no link to the checkout
      await orderFor(tx, w, w.A4, { total: "100.00", source: "SHOPIFY", link: false }); // a website order
      await orderFor(tx, w, w.A10, { total: "100.00", leadId: w.A1.l.id }); // links to a checkout of ANOTHER customer: refused by the same-customer rule
      const c = (await conv(w)).conversion;
      assert.deepEqual([c.converted, c.revenue, c.unclassified], [0, 0, 1]);
    });
  });

  it("the Reports rules decide eligibility and value: PENDING_PAYMENT is not a sale, a delivered order is, and a partial refund reduces the revenue", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await orderFor(tx, w, w.A1, { total: "900.00", mode: "COD", status: "PENDING_PAYMENT" });
      await orderFor(tx, w, w.A2, { total: "1000.00", mode: "PREPAID", pay: "PARTIALLY_REFUNDED", refunded: "250.00", status: "DELIVERED" });
      const c = (await conv(w)).conversion;
      assert.deepEqual([c.converted, c.prepaid, c.cod, c.revenue], [1, { count: 1, revenue: 750 }, { count: 0, revenue: 0 }, 750]);
    });
  });

  it("repeated follow-ups / several orders for one checkout never inflate: the checkout is counted once and only its earliest qualifying order counts", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await orderFor(tx, w, w.A1, { total: "1000.00", mode: "COD" });
      await orderFor(tx, w, w.A1, { total: "1000.00", mode: "COD" }); // a repeated callback / duplicate order
      await tx.recoveryAction.create({ data: { abandonmentId: w.A1.a.id, leadId: w.A1.l.id, type: "CALL", status: "SUCCESS", performedById: w.caller.id } });
      await tx.recoveryAction.create({ data: { abandonmentId: w.A1.a.id, leadId: w.A1.l.id, type: "CALL", status: "SUCCESS", performedById: w.caller.id } });
      const s = await conv(w);
      assert.deepEqual([s.conversion.converted, s.conversion.revenue, s.detected], [1, 1000, 7]);
    });
  });

  it("revenue totals and the conversion rate: converted / detected x 100 (2 dp), revenue = COD + verified prepaid order totals", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await orderFor(tx, w, w.A1, { total: "1200.50", mode: "COD" });
      await orderFor(tx, w, w.A2, { total: "800.25", mode: "PREPAID", pay: "SUCCESS" });
      const c = (await conv(w)).conversion;
      assert.deepEqual([c.converted, c.conversionRate, c.revenue, c.cod.revenue, c.prepaid.revenue], [2, 28.57, 2000.75, 1200.5, 800.25]);
    });
  });

  it("telecaller attribution is the order's creator; a Manager sees only conversions of their own assigned checkouts, an Admin sees all", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const second = await tx.user.create({ data: { name: "Ravi Caller", username: `r-${uid()}`, role: Role.SALESPERSON } });
      await orderFor(tx, w, w.A1, { total: "1000.00", mode: "COD", by: w.caller.id });
      await orderFor(tx, w, w.A10, { total: "400.00", mode: "COD", by: second.id }); // another manager's customer
      const admin = (await conv(w)).conversion;
      assert.deepEqual([admin.converted, admin.revenue], [2, 1400]);
      assert.deepEqual(admin.byTelecaller.map((t) => [t.name, t.converted, t.revenue]), [["Asha Caller", 1, 1000], ["Ravi Caller", 1, 400]]);
      const mgr = await conv(w, Role.MANAGER);
      assert.deepEqual([mgr.conversion.converted, mgr.conversion.revenue, mgr.detected, mgr.conversion.conversionRate], [1, 1000, 6, 16.67]);
      assert.deepEqual(mgr.conversion.byTelecaller.map((t) => t.name), ["Asha Caller"]);
    });
  });
});

describe("conversion breakdowns (clickable cards)", () => {
  it("each conversion card lists exactly the checkouts behind its number, each with its linked order; the rows add up to the card totals; unrelated orders never appear", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const cod = await orderFor(tx, w, w.A1, { total: "1200.50", mode: "COD" });
      const pre = await orderFor(tx, w, w.A2, { total: "800.25", mode: "PREPAID", pay: "SUCCESS" });
      await orderFor(tx, w, w.A5, { total: "700.00", mode: "PREPAID", pay: "PENDING" }); // awaiting payment: not converted, not listed
      await orderFor(tx, w, w.A6, { total: "999.00", link: false }); // same customer, no link: unrelated
      const { summary } = await w.svc.overview(w.as(w.admin, Role.ADMIN), {}, 1, 25);
      const by = async (metric: AbandonedMetric) => detail(w, { metric });
      const conv = await by("CONVERTED");
      const codRows = await by("COD");
      const preRows = await by("PREPAID");
      const all = await by("DETECTED");
      assert.deepEqual(ids(conv.items), aid(w.A1, w.A2));
      assert.deepEqual(ids(codRows.items), aid(w.A1), "COD lists only the COD conversion");
      assert.deepEqual(ids(preRows.items), aid(w.A2), "prepaid lists only the verified prepaid conversion");
      assert.deepEqual(ids(all.items), aid(w.A1, w.A2, w.A3, w.A4, w.A5, w.A6, w.A10), "Total Abandoned lists every checkout of the range once");
      assert.equal(all.pagination.totalItems, summary.detected);
      // the rows carry the order, its payment mode / verification, status, amount and the telecaller
      const row = (rows: typeof conv.items, id: string) => rows.find((r) => r.id === id)!;
      assert.deepEqual(row(conv.items, w.A1.a.id).order, { orderNumber: cod.orderNumber, mode: "COD", status: "CONFIRMED", paymentStatus: "PENDING", amount: 1200.5, collected: 0, telecaller: "Asha Caller" });
      assert.deepEqual(row(conv.items, w.A2.a.id).order, { orderNumber: pre.orderNumber, mode: "PREPAID", status: "CONFIRMED", paymentStatus: "SUCCESS", amount: 800.25, collected: 800.25, telecaller: "Asha Caller" });
      assert.equal(all.items.find((r) => r.id === w.A5.a.id)!.order, null, "an unconverted checkout has no order");
      // breakdown totals = the card totals
      const sum = (rows: typeof conv.items) => Math.round(rows.reduce((s, r) => s + (r.order?.amount ?? 0), 0) * 100) / 100;
      assert.equal(sum(conv.items), summary.conversion.revenue);
      assert.equal(sum(codRows.items), summary.conversion.cod.revenue);
      assert.equal(sum(preRows.items), summary.conversion.prepaid.revenue);
      assert.equal(conv.pagination.totalItems, summary.conversion.converted);
    });
  });

  it("a Manager's breakdowns hold only their own assigned checkouts and orders", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await orderFor(tx, w, w.A1, { total: "1000.00", mode: "COD" });
      await orderFor(tx, w, w.A10, { total: "400.00", mode: "COD" }); // another manager's customer
      const mine = await detail(w, { metric: "COD" }, Role.MANAGER);
      assert.deepEqual(ids(mine.items), aid(w.A1));
      const admin = await detail(w, { metric: "COD" });
      assert.deepEqual(ids(admin.items), aid(w.A1, w.A10));
    });
  });
});
