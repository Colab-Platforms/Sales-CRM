// Database integration test of the HRMS reporting service on the ISOLATED local Postgres (crm_iso on 127.0.0.1:5544) - one rolled-back transaction per test, so nothing persists. It refuses to run against any other
// database. It uses its OWN connection (not the app's Neon client) and fakes the Shopify and telecaller-analytics sources. Run from a folder without a .env (see the run command in the task report).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../generated/prisma/client.js";
import { OrderSource, OrderStatus, PaymentMethod, PaymentStatus, Role } from "../../../generated/prisma/enums.js";
import type { DbClient } from "@/lib/leadScope.js";
import { resolveHrmsRange } from "./hrms.range.js";
import { HrmsReportingService } from "./hrms.service.js";

const URL = "postgresql://iso@127.0.0.1:5544/crm_iso";
const pg = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL }) });
after(() => pg.$disconnect());

class Rollback extends Error {}
async function inRollback(fn: (tx: DbClient) => Promise<void>): Promise<void> {
  try {
    await pg.$transaction(
      async (tx) => {
        const [{ current_database }] = await tx.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
        if (current_database !== "crm_iso") throw new Error(`refusing to run on database ${current_database}`);
        await fn(tx as unknown as DbClient);
        throw new Rollback();
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

// a window far in the past so rows already in the database cannot interfere
const NOW = new Date("2019-03-20T08:00:00Z");
const RANGE = resolveHrmsRange({ range: "custom", from: "2019-03-10", to: "2019-03-11" }, NOW);
const at = (iso: string) => new Date(iso);
const PRIVATE = { first: "Zubinzara", last: "Quillfeather", mobile: "9000012345", email: "zubin.quill@private-example.test", address: "77 Hidden Lane Quillville", order: "ORD-PRIVATE-77XQ" };

const fakeDeps = {
  website: async () => ({ orders: 7, revenueExcludingCancelled: 7000, cod: 3, prepaid: 4, otherPayment: 0, cancelled: 1, cancelledValue: 900, collected: 4000, allShopifyOrders: 9, telecallerCreatedOrders: 2 }),
  telecallerWindow: async () => [
    { id: "will-be-replaced", name: "Asha Tele", accountStatus: "ACTIVE", leads: 5, contacted: 4, interested: 2, converted: 1, calls: 30, connected: 20, notConnected: 8, failed: 2, uniqueLeads: 12, talkTimeSec: 1800, productiveMs: 3_600_000, orders: 2, codOrders: 1, prepaidOrders: 1, assistedOrders: 0, revenue: 1500, assistedRevenue: 0, collected: 500, codRevenue: 1000, codCollected: 0, prepaidRevenue: 500, prepaidCollected: 500 },
  ],
};

async function seed(tx: DbClient) {
  const sfx = randomUUID().slice(0, 8);
  const rep = await tx.user.create({ data: { name: "Asha Tele", username: `asha-${sfx}`, role: Role.SALESPERSON, email: `asha-${sfx}@private-example.test` } as never, select: { id: true } });
  const source = await tx.source.create({ data: { name: `Meta-${sfx}`, code: `meta-${sfx}` }, select: { id: true } });
  const lead = await tx.lead.create({
    data: { leadNumber: `L-${sfx}`, firstName: PRIVATE.first, lastName: PRIVATE.last, mobile: PRIVATE.mobile, normalizedMobile: `91${PRIVATE.mobile}`, email: PRIVATE.email, sourceId: source.id, ownerId: rep.id, createdAt: at("2019-03-10T06:00:00Z") } as never,
    select: { id: true },
  });
  await tx.lead.create({ data: { leadNumber: `L2-${sfx}`, firstName: "Other", mobile: "9000099999", normalizedMobile: "919000099999", sourceId: source.id, workingStatus: "CONVERTED", createdAt: at("2019-03-11T06:00:00Z") } as never });
  const product = await tx.product.create({ data: { name: "Herbal Tea", type: "PRODUCT" } as never, select: { id: true } });
  const mk = async (n: string, status: OrderStatus, total: string, confirmedAt: Date | null, pays: { status: PaymentStatus; method: PaymentMethod; amount: string; paidAt?: Date; refundedAmount?: string }[], items: { name: string; qty: number; total: string }[] = []) => {
    const o = await tx.order.create({
      data: { orderNumber: n === "a" ? PRIVATE.order : `ORD-${n}-${sfx}`, leadId: lead.id, source: OrderSource.SALESPERSON, status, totalAmount: total, confirmedAt, shippingAddress: { name: `${PRIVATE.first} ${PRIVATE.last}`, address1: PRIVATE.address, phone: PRIVATE.mobile }, createdAt: confirmedAt ?? at("2019-03-10T05:00:00Z") } as never,
      select: { id: true },
    });
    for (const p of pays) await tx.payment.create({ data: { orderId: o.id, createdAt: confirmedAt ?? at("2019-03-10T05:00:00Z"), ...p, ...(p.refundedAmount ? { refundedAt: at("2019-03-11T07:00:00Z") } : {}) } as never });
    for (const i of items) await tx.orderItem.create({ data: { orderId: o.id, productId: product.id, productNameSnapshot: i.name, skuSnapshot: "SKU-X", quantity: i.qty, unitPrice: (Number(i.total) / i.qty).toFixed(2), totalPrice: i.total } as never });
    return o;
  };
  const D1 = at("2019-03-10T06:00:00Z");
  const D2 = at("2019-03-11T06:00:00Z");
  await mk("a", OrderStatus.CONFIRMED, "1000.00", D1, [{ status: PaymentStatus.PENDING, method: PaymentMethod.COD, amount: "1000.00" }], [{ name: "Herbal Tea", qty: 2, total: "1000.00" }]);
  await mk("b", OrderStatus.DELIVERED, "500.00", D1, [{ status: PaymentStatus.SUCCESS, method: PaymentMethod.UPI, amount: "500.00", paidAt: D1 }], [{ name: "Herbal Tea", qty: 1, total: "500.00" }]);
  await mk("c", OrderStatus.CONFIRMED, "200.00", D2, [{ status: PaymentStatus.PARTIALLY_REFUNDED, method: PaymentMethod.UPI, amount: "200.00", paidAt: D2, refundedAmount: "50.00" }]);
  await mk("d", OrderStatus.CANCELLED, "700.00", D2, []);
  await mk("e", OrderStatus.CONFIRMED, "300.00", at("2019-03-12T06:00:00Z"), []); // outside the range
  await mk("f", OrderStatus.DRAFT, "999.00", D1, []); // drafts never count
  return { rep };
}

describe("HRMS reporting service on real tables", () => {
  it("sales: revenue, cancelled and collected are separate and exact", async () => {
    await inRollback(async (tx) => {
      await seed(tx);
      const svc = new HrmsReportingService({ db: tx, now: () => NOW, ...fakeDeps });
      const r = await svc.sales(RANGE);
      const crm = r.data.crm;
      const c = crm as never as { orders: Record<string, number>; revenue: Record<string, number | null>; collection: Record<string, number>; byPaymentMode: { cod: { orders: number; outstanding: number } }; byDay: { date: string; orders: number }[] };
      assert.deepEqual(c.orders, { placed: 4, sold: 3, cancelled: 1, returned: 0, refundedInFull: 0, pendingPayment: 0 });
      assert.equal(c.revenue.gross, 1700);
      assert.equal(c.revenue.refunded, 50);
      assert.equal(c.revenue.net, 1650);
      assert.equal(c.collection.collected, 500 + 150);
      assert.equal(c.collection.outstanding, 1000);
      assert.equal(c.byPaymentMode.cod.orders, 1);
      assert.deepEqual(c.byDay.map((d) => d.orders), [2, 1]);
      assert.equal(r.availability.crm!.available, true);
      assert.equal((r.data.website as { orders: number }).orders, 7);
    });
  });

  it("a failing website source is null with an availability error, not zero, and the CRM section is unaffected", async () => {
    await inRollback(async (tx) => {
      await seed(tx);
      const svc = new HrmsReportingService({ db: tx, now: () => NOW, ...fakeDeps, website: async () => { throw new Error("Shopify down secret=abc"); } });
      const r = await svc.sales(RANGE);
      assert.equal(r.data.website, null);
      assert.equal(r.availability.website!.available, false);
      assert.ok(!String(r.availability.website!.error).includes("secret=abc"));
      assert.equal(r.availability.crm!.available, true);
    });
  });

  it("orders, products, payments, leads", async () => {
    await inRollback(async (tx) => {
      await seed(tx);
      const svc = new HrmsReportingService({ db: tx, now: () => NOW, ...fakeDeps });
      const o = (await svc.orders(RANGE)).data.crm as { placed: number; byStatus: { status: string; orders: number }[] };
      assert.equal(o.placed, 4);
      assert.equal(o.byStatus.find((s) => s.status === "CANCELLED")!.orders, 1);

      const p = (await svc.products(RANGE)).data.sales as { items: { name: string; unitsSold: number; grossRevenue: number }[] };
      assert.deepEqual(p.items.map((i) => [i.name, i.unitsSold, i.grossRevenue]), [["Herbal Tea", 3, 1500]]);

      const pay = (await svc.payments(RANGE)).data.payments as { captured: { amount: number; payments: number }; refunds: { amount: number }; net: number; pending: { cod: { amount: number } } };
      assert.equal(pay.captured.amount, 700); // 500 + 200; the unconfirmed COD 1000 is NOT collected
      assert.equal(pay.refunds.amount, 50);
      assert.equal(pay.net, 650);
      assert.equal(pay.pending.cod.amount, 1000);

      const l = (await svc.leads(RANGE)).data.leads as { newLeads: number; converted: number; conversionRate: number };
      assert.equal(l.newLeads, 2);
      assert.equal(l.converted, 1);
      assert.equal(l.conversionRate, 50);
    });
  });

  it("employees: stable CRM id, name, no email/username; telecallers and marketing work", async () => {
    await inRollback(async (tx) => {
      const { rep } = await seed(tx);
      const svc = new HrmsReportingService({ db: tx, now: () => NOW, ...fakeDeps, telecallerWindow: async () => [{ ...(await fakeDeps.telecallerWindow())[0]!, id: rep.id }] });
      const e = (await svc.employees(RANGE)).data.employees as { employeeId: string; name: string; performance: { sales: { netRevenue: number } } | null; attendance: unknown }[];
      const mine = e.find((x) => x.employeeId === rep.id)!;
      assert.equal(mine.name, "Asha Tele");
      assert.equal(mine.performance!.sales.netRevenue, 1500);
      assert.equal(mine.attendance, null); // never clocked in: not tracked, not "absent"
      const t = (await svc.telecallers(RANGE)).data.telecallers as { list: { employeeId: string }[] };
      assert.equal(t.list[0]!.employeeId, rep.id);
      const m = await svc.marketing(RANGE);
      assert.equal(m.availability.marketing!.available, true);
    });
  });

  it("PRIVACY: no customer name, phone, email, address, order number or CRM login appears in any report", async () => {
    await inRollback(async (tx) => {
      const { rep } = await seed(tx);
      const svc = new HrmsReportingService({ db: tx, now: () => NOW, ...fakeDeps, telecallerWindow: async () => [{ ...(await fakeDeps.telecallerWindow())[0]!, id: rep.id }] });
      const all = JSON.stringify([await svc.sales(RANGE), await svc.orders(RANGE), await svc.leads(RANGE), await svc.telecallers(RANGE), await svc.employees(RANGE), await svc.products(RANGE), await svc.payments(RANGE), await svc.marketing(RANGE), await svc.health()]);
      for (const secret of [PRIVATE.first, PRIVATE.last, PRIVATE.mobile, PRIVATE.email, PRIVATE.address, PRIVATE.order, "private-example.test", "ORD-"]) assert.ok(!all.includes(secret), `leaked: ${secret}`);
      assert.ok(!all.includes("password"));
      assert.ok(!all.includes("username"));
    });
  });

  it("health reports the database as reachable", async () => {
    await inRollback(async (tx) => {
      const h = await new HrmsReportingService({ db: tx, now: () => NOW }).health();
      assert.equal(h.ok, true);
      assert.equal(h.timezone, "Asia/Kolkata");
    });
  });
});
