// Orders Dashboard against the real schema, ISOLATED test database only. Service tests run in one rolled-back transaction; the route tests use real signed tokens and only make requests that are refused (or only read).
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
import OrdersDashboardService, { METRICS, type DashboardFilters, type Metric } from "./orders.dashboard.service.js";
import ordersDashboardRoutes from "./orders.dashboard.routes.js";
import { dependencies } from "./orders.dashboard.controller.js";
import { LiveWebsiteDashboardService } from "./orders.dashboard.live.service.js";
import { LiveWebsiteOrders } from "./orders.dashboard.live.source.js";

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
// 11:30 IST on 26 Oct 2026 -> "yesterday" is 25 Oct IST = [24 Oct 18:30Z, 25 Oct 18:30Z)
const NOW = at("2026-10-26T06:00:00Z");
const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });

async function world(tx: Prisma.TransactionClient) {
  const tag = uid();
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${tag}`, role: Role.ADMIN } });
  const manager = await tx.user.create({ data: { name: "Manager", username: `m-${tag}`, role: Role.MANAGER } });
  const asha = await tx.user.create({ data: { name: "Asha Caller", username: `s1-${tag}`, role: Role.SALESPERSON } });
  const bala = await tx.user.create({ data: { name: "Bala Caller", username: `s2-${tag}`, role: Role.SALESPERSON } });
  const lead = (first: string, last: string | null, mobile: string) => tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: first, lastName: last, mobile, normalizedMobile: `+91${mobile}` } });
  const [lw, lt] = [await lead("Webcustomer", "One", "9000000001"), await lead("Teleclient", "Two", "9000000002")];
  let n = 0;
  const order = async (key: string, o: { createdAt: string; source: "SHOPIFY" | "SALESPERSON" | "API" | "WEBSITE"; total: string; mode?: "COD" | "PREPAID"; status?: Prisma.OrderUncheckedCreateInput["status"]; by?: string; ext?: boolean; pay?: { status: "SUCCESS" | "PENDING"; method: "COD" | "UPI" } }) => {
    n++;
    const row = await tx.order.create({
      data: {
        orderNumber: `ORD-${key}-${uid()}`,
        leadId: o.source === "SALESPERSON" ? lt.id : lw.id,
        source: o.source,
        status: o.status ?? "CONFIRMED",
        totalAmount: o.total,
        createdAt: at(o.createdAt),
        createdById: o.by ?? null,
        ...(o.ext ? { externalSource: "SHOPIFY" as const, externalId: `9${n}${uid()}`, externalNumber: `#${1000 + n}` } : { externalNumber: o.source === "SHOPIFY" ? `#${1000 + n}` : null }),
        ...(o.mode ? { metadata: { paymentMode: o.mode } } : {}),
      },
    });
    if (o.pay) await tx.payment.create({ data: { orderId: row.id, amount: o.total, method: o.pay.method, status: o.pay.status } });
    return row;
  };
  // ---- the fixture. IST day of 25 Oct = [24 Oct 18:30Z, 25 Oct 18:30Z)
  const W1 = await order("W1", { createdAt: "2026-10-25T10:00:00Z", source: "SHOPIFY", ext: true, total: "1000.00", mode: "COD", pay: { status: "PENDING", method: "COD" } });
  const W2 = await order("W2", { createdAt: "2026-10-24T18:29:59.999Z", source: "SHOPIFY", ext: true, total: "111.00", mode: "COD" }); // 1 ms before yesterday starts
  const W3 = await order("W3", { createdAt: "2026-10-24T18:30:00.000Z", source: "SHOPIFY", ext: true, total: "500.00", mode: "PREPAID", status: "DELIVERED", pay: { status: "SUCCESS", method: "UPI" } }); // exactly at start
  const W4 = await order("W4", { createdAt: "2026-10-25T18:30:00.000Z", source: "SHOPIFY", ext: true, total: "444.00", mode: "COD" }); // exactly at end -> today
  const T1 = await order("T1", { createdAt: "2026-10-25T05:00:00Z", source: "SALESPERSON", by: asha.id, total: "700.00", mode: "COD" });
  const T2 = await order("T2", { createdAt: "2026-10-25T07:00:00Z", source: "SALESPERSON", by: bala.id, ext: true, total: "300.00", mode: "PREPAID", status: "SHIPPED", pay: { status: "SUCCESS", method: "UPI" } }); // pushed to Shopify
  const T3 = await order("T3", { createdAt: "2026-10-25T08:00:00Z", source: "SALESPERSON", by: asha.id, total: "200.00", mode: "PREPAID", status: "CANCELLED" });
  const A1 = await order("A1", { createdAt: "2026-10-25T09:00:00Z", source: "API", total: "50.00" });
  const D1 = await order("D1", { createdAt: "2026-10-25T09:30:00Z", source: "SHOPIFY", total: "9999.00", status: "DRAFT" });
  // Shopify is never called in a test. By default the fake "Shopify" agrees with the CRM (it reports exactly the orders that carry a Shopify id); a test can make it say something else.
  const shopify = { override: null as null | ((from: Date, to: Date) => Promise<number | null>) };
  const counter = async (from: Date, to: Date) => (shopify.override ? shopify.override(from, to) : tx.order.count({ where: { createdAt: { gte: from, lt: to }, externalSource: "SHOPIFY", status: { not: "DRAFT" } } }));
  const svc = new OrdersDashboardService(tx, () => NOW, counter);
  return { admin, manager, asha, bala, W1, W2, W3, W4, T1, T2, T3, A1, D1, svc, shopify, as: (u: typeof admin, r: Role) => as(u, r) };
}
const ids = (items: { id: string }[]) => items.map((i) => i.id).sort();
type World = Awaited<ReturnType<typeof world>>;
/** The details (rows + tab counts) for a clicked card. */
const detail = async (w: World, f: DashboardFilters & { page?: number; pageSize?: number }) => {
  const { page = 1, pageSize = 100, ...rest } = f;
  const r = await w.svc.overview(w.as(w.admin, Role.ADMIN), rest, page, pageSize);
  assert.ok(r.details, "a clicked card returns its details");
  return { ...r, ...r.details! };
};
const cardsOf = (w: World, f: DashboardFilters = {}) => w.svc.overview(w.as(w.admin, Role.ADMIN), f, 1, 25);

describe("access", () => {
  it("every route refuses telecallers, HR, recruiters and anonymous users; Admin and Manager are let in (and a bad range or card is a 400)", async () => {
    const app = express();
    app.use("/api/orders-dashboard", ordersDashboardRoutes);
    app.use(errorHandler);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/orders-dashboard`;
      const call = (path: string, token?: string) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      const token = (role: Role) => signToken({ sub: randomUUID(), role, username: "x" } as never);
      for (const role of [Role.SALESPERSON, Role.HR, Role.RECRUITER]) {
        assert.equal((await call("/", token(role))).status, 403, role);
        assert.equal((await call("/?metric=COD&section=WEBSITE", token(role))).status, 403, `${role} details`);
        assert.equal((await call("/export", token(role))).status, 403, `${role} export`);
      }
      assert.equal((await call("/")).status, 401);
      assert.equal((await call("/export")).status, 401);
      for (const role of [Role.ADMIN, Role.MANAGER]) {
        assert.equal((await call("/", token(role))).status, 200, role);
        assert.equal((await call("/?metric=PAID&section=TELECALLER", token(role))).status, 200);
        assert.equal((await call("/?range=custom&from=2026-10-22&to=2026-10-20", token(role))).status, 400);
        assert.equal((await call("/?metric=NOT_A_CARD", token(role))).status, 400);
        assert.equal((await call("/?pageSize=5000", token(role))).status, 400);
        const x = await call("/export?metric=COD", token(role));
        assert.equal(x.status, 200);
        assert.match(x.headers.get("content-type") ?? "", /spreadsheetml/);
      }
    } finally {
      server.close();
    }
  });

  it("the service refuses non Admin/Manager roles itself, whatever the route does", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      for (const role of [Role.SALESPERSON, Role.HR, Role.RECRUITER]) {
        await assert.rejects(() => w.svc.overview(w.as(w.asha, role), { metric: "TOTAL" }, 1, 10), /Forbidden/);
        await assert.rejects(() => w.svc.exportXlsx(w.as(w.asha, role), {}), /Forbidden/);
      }
      assert.ok((await cardsOf(w)).summary.totalOrders > 0);
      assert.ok((await w.svc.overview(w.as(w.manager, Role.MANAGER), { metric: "TOTAL" }, 1, 10)).details!.items.length > 0);
    });
  });
});

describe("cards-only by default", () => {
  it("with no card clicked the server returns the summary and reads NO order rows at all", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await cardsOf(w);
      assert.equal(r.details, null);
      assert.deepEqual([r.range.kind, r.range.from], ["yesterday", "2026-10-25"]);
      assert.deepEqual(r.summary, { totalOrders: 6, totalValue: 2550, cod: 2, prepaid: 3, paid: 2, pendingPayment: 1, cancelled: 1, cancelledValue: 200, fulfilled: 2 });
    });
  });

  it("the cards depend on the date range only: a clicked card, tab, search or filter never changes them", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const base = (await cardsOf(w)).summary;
      for (const f of [{ metric: "COD" }, { metric: "PAID", section: "TELECALLER" }, { metric: "TOTAL", section: "WEBSITE", search: "webcustomer" }, { metric: "CANCELLED", paymentStatus: "SUCCESS" }, { metric: "VALUE", fulfilment: "FULFILLED", source: "SALESPERSON" }] as DashboardFilters[]) {
        assert.deepEqual((await cardsOf(w, f)).summary, base, JSON.stringify(f));
      }
      // a different range changes them
      assert.notDeepEqual((await cardsOf(w, { range: "today" })).summary, base);
    });
  });
});

describe("clicking a card", () => {
  it("every card's rows are exactly the orders behind its number (website tab + telecaller tab + API = the card)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { summary } = await cardsOf(w);
      const expected: Record<Metric, { count: number; ids: string[]; value?: number }> = {
        TOTAL: { count: summary.totalOrders, ids: ids([w.W1, w.W3, w.T1, w.T2, w.T3, w.A1]) },
        VALUE: { count: 5, ids: ids([w.W1, w.W3, w.T1, w.T2, w.A1]), value: summary.totalValue },
        COD: { count: summary.cod, ids: ids([w.W1, w.T1]) },
        PREPAID: { count: summary.prepaid, ids: ids([w.W3, w.T2, w.T3]) },
        PAID: { count: summary.paid, ids: ids([w.W3, w.T2]) },
        PENDING: { count: summary.pendingPayment, ids: ids([w.W1]) },
        CANCELLED: { count: summary.cancelled, ids: ids([w.T3]) },
        FULFILLED: { count: summary.fulfilled, ids: ids([w.W3, w.T2]) },
      };
      for (const metric of METRICS) {
        const all = await detail(w, { metric }); // section omitted = every source
        assert.deepEqual(ids(all.items), expected[metric].ids, metric);
        assert.equal(all.pagination.totalItems, expected[metric].count, `${metric}: the number on the card equals the rows`);
        const web = await detail(w, { metric, section: "WEBSITE" });
        const tele = await detail(w, { metric, section: "TELECALLER" });
        assert.equal(web.sections.website + web.sections.telecaller + web.sections.other, expected[metric].count, `${metric}: the tabs add up to the card`);
        assert.equal(web.pagination.totalItems, web.sections.website, `${metric}: the Website tab count is its rows`);
        assert.equal(tele.pagination.totalItems, tele.sections.telecaller, `${metric}: the Telecaller tab count is its rows`);
        assert.deepEqual(ids([...web.items, ...tele.items]), expected[metric].ids.filter((id) => ![w.A1.id].includes(id)), `${metric}: the two tabs hold everything except API orders`);
        if (expected[metric].value !== undefined) assert.equal(all.items.reduce((s, i) => s + i.totalAmount, 0), expected[metric].value, "the rows add up to the value card");
      }
    });
  });

  it("each tab shows only its own source, with the card applied; the telecaller tab names the telecaller; switching tab keeps the card and the date range", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const web = await detail(w, { metric: "PAID", section: "WEBSITE" });
      const tele = await detail(w, { metric: "PAID", section: "TELECALLER" });
      assert.deepEqual(ids(web.items), ids([w.W3]));
      assert.deepEqual(ids(tele.items), ids([w.T2]));
      assert.ok(web.items.every((i) => i.section === "WEBSITE" && i.telecallerName === null));
      assert.equal(tele.items[0]!.telecallerName, "Bala Caller");
      assert.deepEqual([web.metric, tele.metric], ["PAID", "PAID"]);
      assert.deepEqual([web.range.from, tele.range.from], ["2026-10-25", "2026-10-25"]);
      assert.deepEqual([web.sections.website, web.sections.telecaller], [1, 1], "both tab counts shown whichever tab is open");
      const cod = await detail(w, { metric: "COD", section: "TELECALLER", range: "custom", from: "2026-10-24", to: "2026-10-26" });
      assert.deepEqual(ids(cod.items), ids([w.T1]));
      assert.equal(cod.range.from, "2026-10-24");
    });
  });

  it("changing the date range changes the cards, the tab counts and the rows together", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const today = await detail(w, { metric: "TOTAL", section: "WEBSITE", range: "today" });
      assert.deepEqual(ids(today.items), ids([w.W4]));
      assert.deepEqual([today.sections.website, today.sections.telecaller, today.summary.totalOrders], [1, 0, 1]);
      const wide = await detail(w, { metric: "TOTAL", section: "WEBSITE", range: "custom", from: "2026-10-24", to: "2026-10-26" });
      assert.deepEqual(ids(wide.items), ids([w.W1, w.W2, w.W3, w.W4]));
      assert.equal(wide.summary.totalOrders, 8);
      await assert.rejects(() => detail(w, { metric: "TOTAL", range: "custom", from: "2026-10-26", to: "2026-10-25" }), /From date must be on or before/);
      await assert.rejects(() => detail(w, { metric: "TOTAL", range: "custom", from: "2026-10-25", to: "2026-10-30" }), /future/);
    });
  });

  it("NO DOUBLE COUNT: a telecaller order that carries a Shopify id is ONE row, counted once, in the Telecaller tab and never in the Website tab - in every card it belongs to", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const t2 = await tx.order.findUniqueOrThrow({ where: { id: w.T2.id } });
      assert.equal(t2.externalSource, "SHOPIFY");
      assert.equal(await tx.order.count({ where: { externalSource: "SHOPIFY", externalId: t2.externalId } }), 1);
      for (const metric of ["TOTAL", "VALUE", "PREPAID", "PAID", "FULFILLED"] as const) {
        const web = await detail(w, { metric, section: "WEBSITE" });
        const tele = await detail(w, { metric, section: "TELECALLER" });
        assert.ok(!ids(web.items).includes(w.T2.id), `${metric}: not on the website tab`);
        assert.equal(ids(tele.items).filter((id) => id === w.T2.id).length, 1, `${metric}: once on the telecaller tab`);
      }
      const total = await detail(w, { metric: "TOTAL" });
      assert.equal(new Set(total.items.map((i) => i.id)).size, total.items.length);
      assert.equal(total.summary.totalOrders, total.sections.website + total.sections.telecaller + total.sections.other);
      await tx.order.update({ where: { id: w.T2.id }, data: { externalUpdatedAt: NOW, status: "DELIVERED" } }); // what a Shopify sync does to that row
      assert.equal((await detail(w, { metric: "FULFILLED", section: "TELECALLER" })).items.filter((i) => i.id === w.T2.id).length, 1);
      assert.equal((await detail(w, { metric: "FULFILLED", section: "WEBSITE" })).items.length, 1);
    });
  });
});

describe("search, filters, pagination and export inside a clicked card", () => {
  it("search (order id, customer, phone), payment and fulfilment filters apply on top of the card and stay inside the date range", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const w1 = await tx.order.findUniqueOrThrow({ where: { id: w.W1.id } });
      assert.deepEqual(ids((await detail(w, { metric: "TOTAL", section: "WEBSITE", search: w1.externalNumber! })).items), ids([w.W1]));
      assert.deepEqual(ids((await detail(w, { metric: "TOTAL", section: "TELECALLER", search: w.T1.orderNumber })).items), ids([w.T1]));
      assert.deepEqual(ids((await detail(w, { metric: "TOTAL", section: "TELECALLER", search: "teleclient" })).items), ids([w.T1, w.T2, w.T3]));
      assert.deepEqual(ids((await detail(w, { metric: "TOTAL", section: "TELECALLER", search: "9000000002" })).items), ids([w.T1, w.T2, w.T3]));
      assert.equal((await detail(w, { metric: "TOTAL", search: "nobody-by-that-name" })).items.length, 0);
      assert.equal((await detail(w, { metric: "TOTAL", search: w.W2.orderNumber })).items.length, 0, "W2 is outside the selected day");
      assert.deepEqual(ids((await detail(w, { metric: "PREPAID", section: "TELECALLER", paymentStatus: "SUCCESS" })).items), ids([w.T2]));
      assert.deepEqual(ids((await detail(w, { metric: "TOTAL", section: "WEBSITE", fulfilment: "FULFILLED" })).items), ids([w.W3]));
      // the tab counts ignore the search and filters, so the tabs always show what the card holds
      const filtered = await detail(w, { metric: "TOTAL", section: "TELECALLER", search: "nobody-by-that-name" });
      assert.deepEqual([filtered.sections.website, filtered.sections.telecaller], [2, 3]);
    });
  });

  it("server-side pagination inside a card: disjoint, newest first, exactly the card's rows; tab counts and cards do not depend on the page", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const p1 = await detail(w, { metric: "TOTAL", page: 1, pageSize: 4 });
      const p2 = await detail(w, { metric: "TOTAL", page: 2, pageSize: 4 });
      assert.deepEqual([p1.items.length, p2.items.length, p1.pagination.totalItems, p1.pagination.totalPages], [4, 2, 6, 2]);
      assert.deepEqual([p1.sections, p1.summary], [p2.sections, p2.summary]);
      assert.equal(new Set([...p1.items, ...p2.items].map((i) => i.id)).size, 6);
      const dates = [...p1.items, ...p2.items].map((i) => +i.orderDate);
      assert.deepEqual(dates, [...dates].sort((x, y) => y - x));
      const tele = await detail(w, { metric: "TOTAL", section: "TELECALLER", page: 1, pageSize: 2 });
      assert.deepEqual([tele.items.length, tele.pagination.totalItems, tele.pagination.totalPages], [2, 3, 2]);
      assert.equal((await detail(w, { metric: "TOTAL", page: 3, pageSize: 4 })).items.length, 0);
    });
  });

  it("the Excel export follows the clicked card, the tab and the date range (and is formula-safe)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = w.as(w.admin, Role.ADMIN);
      await tx.lead.update({ where: { id: (await tx.order.findUniqueOrThrow({ where: { id: w.T1.id } })).leadId }, data: { firstName: "=HYPERLINK(\"http://evil\")" } });
      const read = async (f: DashboardFilters) => {
        const file = await w.svc.exportXlsx(a, f);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(file.buffer as never);
        const rows: string[] = [];
        const customers = new Set<string>();
        wb.getWorksheet("Orders")!.eachRow((r, i) => { if (i > 1) { rows.push(String(r.getCell(1).value)); customers.add(String(r.getCell(3).value)); } });
        const summary = new Map<string, unknown>();
        wb.getWorksheet("Summary")!.eachRow((r) => summary.set(String(r.getCell(1).value), r.getCell(2).value));
        return { file, rows, customers, summary };
      };
      assert.equal((await read({})).rows.length, 6);
      const cod = await read({ metric: "COD" });
      assert.equal(cod.rows.length, 2);
      assert.deepEqual([cod.summary.get("Card clicked"), cod.summary.get("Date range")], ["COD", "2026-10-25"]);
      assert.equal(cod.file.filename, "Orders_All_cod_2026-10-25.xlsx");
      const teleCod = await read({ metric: "COD", section: "TELECALLER" });
      assert.equal(teleCod.rows.length, 1);
      assert.equal(teleCod.file.filename, "Orders_Telecaller_cod_2026-10-25.xlsx");
      assert.ok([...teleCod.customers].some((c) => c.startsWith("'=")), "a formula-like customer name is stored as text");
      assert.equal((await read({ metric: "PAID", section: "WEBSITE" })).rows.length, 1);
      assert.equal((await read({ metric: "TOTAL", range: "custom", from: "2026-10-24", to: "2026-10-26" })).rows.length, 8);
      assert.equal((await read({ metric: "CANCELLED" })).rows.length, 1);
    });
  });

  it("freshness: warns when the newest synced website order is older than the end of the selected range", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await cardsOf(w, { range: "today" });
      assert.equal(r.freshness.websiteMayBeIncomplete, true);
      assert.equal(new Date(r.freshness.latestWebsiteOrderAt as Date).getTime() >= +at("2026-10-25T18:30:00Z"), true);
    });
  });
});

describe("Website Orders dashboard (scope = WEBSITE): storefront orders only", () => {
  const site = (w: World, f: DashboardFilters & { page?: number; pageSize?: number } = {}) => {
    const { page = 1, pageSize = 100, ...rest } = f;
    return w.svc.overview(w.as(w.admin, Role.ADMIN), { scope: "WEBSITE", ...rest }, page, pageSize);
  };

  it("its cards count ONLY storefront orders - telecaller orders (also those pushed to Shopify) and API orders are not part of it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await site(w);
      // yesterday's website orders: W1 (COD, payment pending, 1000) and W3 (prepaid, paid, delivered, 500)
      assert.deepEqual(r.summary, { totalOrders: 2, totalValue: 1500, cod: 1, prepaid: 1, paid: 1, pendingPayment: 1, cancelled: 0, cancelledValue: 0, fulfilled: 1 });
      assert.equal(r.details, null);
      const combined = await cardsOf(w); // the older combined view still counts everyone
      assert.equal(combined.summary.totalOrders, 6);
    });
  });

  it("every website card's rows are exactly its number; rows are website orders only (T2, pushed to Shopify, is a telecaller order and absent)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { summary } = await site(w);
      const want: Record<Metric, { ids: string[]; count: number }> = {
        TOTAL: { ids: ids([w.W1, w.W3]), count: summary.totalOrders },
        VALUE: { ids: ids([w.W1, w.W3]), count: 2 },
        COD: { ids: ids([w.W1]), count: summary.cod },
        PREPAID: { ids: ids([w.W3]), count: summary.prepaid },
        PAID: { ids: ids([w.W3]), count: summary.paid },
        PENDING: { ids: ids([w.W1]), count: summary.pendingPayment },
        CANCELLED: { ids: [], count: summary.cancelled },
        FULFILLED: { ids: ids([w.W3]), count: summary.fulfilled },
      };
      for (const metric of METRICS) {
        const r = await site(w, { metric });
        assert.deepEqual(ids(r.details!.items), want[metric].ids, metric);
        assert.equal(r.details!.pagination.totalItems, want[metric].count, `${metric}: card number = rows`);
        assert.ok(r.details!.items.every((i) => i.section === "WEBSITE" && i.telecallerName === null));
        assert.ok(!ids(r.details!.items).includes(w.T2.id) && !ids(r.details!.items).includes(w.A1.id));
      }
    });
  });

  it("the website range follows IST: the order 1 ms before the day and the one exactly at its end are not in yesterday; today and a custom range work; the export is website-only", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      assert.deepEqual(ids((await site(w, { metric: "TOTAL", range: "today" })).details!.items), ids([w.W4]));
      const wide = await site(w, { metric: "TOTAL", range: "custom", from: "2026-10-24", to: "2026-10-26" });
      assert.deepEqual(ids(wide.details!.items), ids([w.W1, w.W2, w.W3, w.W4]));
      assert.equal(wide.summary.totalOrders, 4);
      const file = await w.svc.exportXlsx(w.as(w.admin, Role.ADMIN), { scope: "WEBSITE", metric: "COD" });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.buffer as never);
      const sections = new Set<string>();
      wb.getWorksheet("Orders")!.eachRow((r, i) => { if (i > 1) sections.add(String(r.getCell(11).value)); });
      assert.deepEqual([...sections], ["WEBSITE"]);
      assert.equal(file.rows, 1);
    });
  });

  it("the feed health is reported honestly: how many Shopify webhooks this CRM has ever received, and when the last one arrived", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const none = (await site(w)).freshness;
      assert.deepEqual([none.shopifyWebhooksReceived, none.lastShopifyWebhookAt], [0, null]);
      await tx.webhookEvent.create({ data: { provider: "SHOPIFY", eventType: "orders/create", externalEventId: `e-${uid()}`, payload: {}, receivedAt: at("2026-10-26T05:00:00Z") } });
      const one = (await site(w)).freshness;
      assert.equal(one.shopifyWebhooksReceived, 1);
      assert.equal(new Date(one.lastShopifyWebhookAt as Date).toISOString(), "2026-10-26T05:00:00.000Z");
    });
  });
});

describe("Orders & Revenue chart, coverage and comparison (Website Orders)", () => {
  const admin = (w: World) => w.as(w.admin, Role.ADMIN);
  const site = (w: World, f: DashboardFilters = {}) => w.svc.overview(admin(w), { scope: "WEBSITE", ...f }, 1, 100);
  const chart = (w: World, f: object, interval: "daily" | "weekly" | "monthly" = "daily") => w.svc.chart(admin(w), f as never, interval);
  const RANGE = { range: "custom" as const, from: "2026-10-24", to: "2026-10-26" };
  const oldOrder = async (tx: Prisma.TransactionClient, w: World) =>
    tx.order.create({ data: { orderNumber: `ORD-OLD-${uid()}`, leadId: (await tx.order.findUniqueOrThrow({ where: { id: w.W1.id } })).leadId, source: "SHOPIFY", status: "CONFIRMED", totalAmount: "10.00", createdAt: at("2026-10-01T10:00:00Z"), externalSource: "SHOPIFY", externalId: `55${uid()}` } });

  it("daily buckets are in IST and add up to the cards for the SAME range (bars = Total Orders, line = Total Order Value)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const c = await chart(w, RANGE);
      assert.deepEqual(c.buckets.map((b) => [b.key, b.orders, b.revenue]), [["2026-10-24", 1, 111], ["2026-10-25", 2, 1500], ["2026-10-26", 1, 444]], "W2 at 23:59:59.999 IST is the 24th; W3 at 00:00 IST the 25th; W4 at 00:00 IST the 26th");
      const cards = (await site(w, RANGE)).summary;
      assert.deepEqual([c.totals.orders, c.totals.revenue], [cards.totalOrders, cards.totalValue]);
      assert.equal(c.interval, "daily");
    });
  });

  it("only storefront orders are charted: telecaller orders (also the one pushed to Shopify), API orders and drafts are in no bucket", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const c = await chart(w, { range: "custom", from: "2026-10-25", to: "2026-10-25" });
      assert.deepEqual(c.buckets.map((b) => b.orders), [2], "W1 + W3 only; T1-T3, A1 and D1 are also created that day");
    });
  });

  it("weekly (Monday start) and monthly buckets keep the same totals", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const weekly = await chart(w, RANGE, "weekly");
      assert.deepEqual(weekly.buckets.map((b) => [b.key, b.from, b.to, b.orders, b.revenue]), [["2026-10-19", "2026-10-24", "2026-10-25", 3, 1611], ["2026-10-26", "2026-10-26", "2026-10-26", 1, 444]]);
      const monthly = await chart(w, RANGE, "monthly");
      assert.deepEqual(monthly.buckets.map((b) => [b.key, b.orders, b.revenue]), [["2026-10-01", 4, 2055]]);
      assert.deepEqual([weekly.totals, monthly.totals], [{ orders: 4, revenue: 2055 }, { orders: 4, revenue: 2055 }]);
    });
  });

  it("a period the synced orders do not cover is UNAVAILABLE (no numbers), never a zero; with older orders in the database the same days are genuine zeros", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      w.shopify.override = async () => 5; // Shopify has orders in these days that the CRM never received
      const gap = await chart(w, { range: "custom", from: "2026-10-20", to: "2026-10-23" });
      assert.equal(gap.coverage, "NONE");
      assert.ok(gap.buckets.every((b) => b.available === false && b.orders === null && b.revenue === null));
      assert.deepEqual(gap.totals, { orders: 0, revenue: 0 });
      await oldOrder(tx, w);
      w.shopify.override = null; // Shopify agrees with the CRM again: nothing was there to import
      const covered = await chart(w, { range: "custom", from: "2026-10-20", to: "2026-10-23" });
      assert.equal(covered.coverage, "FULL");
      assert.ok(covered.buckets.every((b) => b.available && b.orders === 0 && b.revenue === 0), "now they are real zeros");
    });
  });

  it("cards report their coverage: FULL for a covered day, NONE when the feed has not reached the period (the page shows 'no data', not 0); a live webhook makes a quiet day a real zero", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      assert.equal((await site(w)).coverage, "FULL", "yesterday is spanned by the synced orders");
      await tx.order.delete({ where: { id: w.W4.id } }); // the newest synced website order is now W3 (25 Oct 00:00 IST)
      w.shopify.override = async (from) => (from >= at("2026-10-25T18:30:00Z") ? 3 : tx.order.count({ where: { createdAt: { gte: from }, externalSource: "SHOPIFY", status: { not: "DRAFT" } } })); // Shopify has 3 orders today
      const today = await site(w, { range: "today" });
      assert.equal(today.coverage, "NONE");
      assert.equal(today.summary.totalOrders, 0, "the raw count is 0 - the page must not show it as a real zero");
      w.shopify.override = async () => null; // Shopify cannot be asked: the CRM never claims a period is complete
      assert.equal((await site(w, { range: "yesterday" })).coverage, "PARTIAL");
      w.shopify.override = async (from) => (from >= at("2026-10-25T18:30:00Z") ? 0 : 1); // Shopify itself has no order today: a genuine zero
      assert.equal((await site(w, { range: "today" })).coverage, "FULL");
    });
  });

  it("comparison with the previous period appears only when BOTH periods are fully covered", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      w.shopify.override = async (_from, to) => (to <= at("2026-10-24T18:30:00Z") ? 5 : tx.order.count({ where: { createdAt: { lt: to }, externalSource: "SHOPIFY", status: { not: "DRAFT" } } })); // the day before: Shopify has orders the CRM lacks
      assert.equal((await site(w)).comparison, null, "the day before has no synced orders before it: no comparison");
      await oldOrder(tx, w);
      w.shopify.override = null;
      const r = await site(w);
      assert.deepEqual(r.comparison?.totalOrders, { previous: 1, changePct: 100 }, "25 Oct: 2 orders vs 24 Oct: 1 order (W2)");
      assert.deepEqual(r.comparison?.totalValue, { previous: 111, changePct: 1251.4 });
      assert.equal(r.range.days, 1);
    });
  });

  it("the chart routes are admin / manager only, every date preset works and bad input is refused", async () => {
    // Website Orders read Shopify live: here Shopify is a fake that holds no orders, so this test never leaves the machine.
    const emptyShopify = { query: async (document: string) => (document.includes("OrderList") ? { orders: { pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, nodes: [] } } : { result: { count: 0, precision: "EXACT" } }) };
    dependencies.live = new LiveWebsiteDashboardService(new LiveWebsiteOrders({ db: { order: { findMany: async () => [] } } as never, client: () => emptyShopify as never }));
    const app = express();
    app.use("/api/orders-dashboard", ordersDashboardRoutes);
    app.use(errorHandler);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/orders-dashboard`;
      const call = (path: string, token?: string) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      const token = (role: Role) => signToken({ sub: randomUUID(), role, username: "x" } as never);
      for (const role of [Role.SALESPERSON, Role.HR, Role.RECRUITER]) {
        assert.equal((await call("/chart", token(role))).status, 403, role);
        assert.equal((await call("/abandoned/chart", token(role))).status, 403, role);
      }
      assert.equal((await call("/chart")).status, 401);
      for (const role of [Role.ADMIN, Role.MANAGER]) {
        for (const kind of ["today", "yesterday", "this_week", "last_7_days", "last_30_days", "this_month", "last_month"]) {
          assert.equal((await call(`/chart?range=${kind}&interval=weekly`, token(role))).status, 200, kind);
          assert.equal((await call(`/?range=${kind}`, token(role))).status, 200, `${kind} cards`);
          assert.equal((await call(`/abandoned/chart?range=${kind}`, token(role))).status, 200, `${kind} abandoned chart`);
        }
        assert.equal((await call("/chart?interval=hourly", token(role))).status, 400);
        assert.equal((await call("/chart?range=custom&from=2026-10-22&to=2026-10-20", token(role))).status, 400);
        assert.equal((await call("/chart?range=last_year", token(role))).status, 400);
      }
    } finally {
      server.close();
    }
  });
});
