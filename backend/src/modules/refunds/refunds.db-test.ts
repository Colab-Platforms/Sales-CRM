// Refund APPROVAL workflow (Phase 1A) against the real schema. Run with: npm run test:db
//
// Functional tests run inside ONE transaction that is always rolled back. The concurrency tests need real, simultaneous transactions, so they
// commit throw-away rows under unique ids and delete them afterwards. Nothing here ever contacts Cashfree: the workflow has no provider code,
// and a test asserts that no network call is made.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivityType, OrderSource, OrderStatus, PaymentMethod, PaymentStatus, RefundRequestStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Db, TxRunner } from "../integrations/integrations.common.js";
import RefundsService, { loadOrderRefundInfo } from "./refunds.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Db, svc: RefundsService) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        const runner: TxRunner = { $transaction: (cb) => cb(tx) };
        await fn(tx, new RefundsService(runner));
        throw new Rollback();
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
type U = { id: string; email: string; role: Role };
const as = (u: { id: string; email: string }, role: Role): U => ({ id: u.id, email: u.email, role });
const mk = (tx: Db, name: string, role: Role) => tx.user.create({ data: { name, email: `${name.toLowerCase()}-${uid()}@example.invalid`, role }, select: { id: true, email: true } });

interface World {
  sales: U;
  sales2: U;
  manager: U;
  manager2: U;
  outsiderManager: U;
  admin: U;
  admin2: U;
  orderId: string;
  paymentId: string;
  leadId: string;
  groupId: string;
  sourceId: string;
}

/** A team (manager + salesperson owning the lead), an out-of-scope manager/salesperson, two admins, and one paid Cashfree order of ₹1000. */
async function world(tx: Db, payment: Partial<Prisma.PaymentUncheckedCreateInput> = {}): Promise<World> {
  const [s, s2, m, m2, om, a, a2] = await Promise.all([mk(tx, "Sales", Role.SALESPERSON), mk(tx, "Sales2", Role.SALESPERSON), mk(tx, "Mgr", Role.MANAGER), mk(tx, "Mgr2", Role.MANAGER), mk(tx, "Outsider", Role.MANAGER), mk(tx, "Admin", Role.ADMIN), mk(tx, "Admin2", Role.ADMIN)]);
  const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: m.id }, select: { id: true } });
  await tx.groupMember.create({ data: { groupId: group.id, userId: s.id, joinedAt: new Date(), isActive: true } });
  const source = await tx.source.create({ data: { name: "Website", code: `web-${uid()}` }, select: { id: true } });
  const lead = await tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", mobile: "9876500000", normalizedMobile: "919876500000", sourceId: source.id, ownerId: s.id, groupId: group.id },
    select: { id: true },
  });
  const order = await tx.order.create({
    data: { orderNumber: `RF-${uid().slice(0, 8)}`, leadId: lead.id, source: OrderSource.SALESPERSON, status: OrderStatus.CONFIRMED, subtotal: "1000.00", totalAmount: "1000.00", createdById: s.id },
    select: { id: true },
  });
  const pay = await tx.payment.create({
    data: {
      orderId: order.id,
      provider: "Cashfree",
      providerPaymentId: "cfpay_1",
      providerOrderId: `link_${uid().slice(0, 8)}`,
      amount: "1000.00",
      method: PaymentMethod.UPI,
      status: PaymentStatus.SUCCESS,
      externalSource: "CASHFREE",
      externalId: `link_${uid().slice(0, 12)}`,
      paidAt: new Date(),
      metadata: { cashfree: { cashfreeOrderId: "cforder_1" } },
      ...payment,
    },
    select: { id: true },
  });
  return { sales: as(s, Role.SALESPERSON), sales2: as(s2, Role.SALESPERSON), manager: as(m, Role.MANAGER), manager2: as(m2, Role.MANAGER), outsiderManager: as(om, Role.MANAGER), admin: as(a, Role.ADMIN), admin2: as(a2, Role.ADMIN), orderId: order.id, paymentId: pay.id, leadId: lead.id, groupId: group.id, sourceId: source.id };
}

const body = (w: World, amount: string, extra: Partial<{ reason: string; submissionKey: string }> = {}) => ({ paymentId: w.paymentId, amount, reason: extra.reason ?? "Customer returned the product", ...(extra.submissionKey ? { submissionKey: extra.submissionKey } : {}) });
const rejects = async (p: Promise<unknown>, status: number, re?: RegExp) =>
  assert.rejects(p, (e: any) => {
    assert.equal(e.statusCode, status, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });

describe("creating a refund request", () => {
  it("a salesperson raises a PENDING request for their own order; the audit event is recorded with actor, role and ids", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const r = await svc.createRequest(w.sales, w.orderId, body(w, "250.50", { reason: "  Wrong item delivered  " }));
      assert.equal(r.status, "PENDING");
      assert.equal(r.amount, "250.50");
      assert.equal(r.reason, "Wrong item delivered");
      assert.deepEqual([r.requestedBy.id, r.requestedBy.role, r.decidedBy], [w.sales.id, Role.SALESPERSON, null]);
      assert.equal(r.remainingRefundableAmount, "749.50");
      const acts = await tx.activity.findMany({ where: { orderId: w.orderId, type: ActivityType.REFUND_REQUESTED } });
      assert.equal(acts.length, 1);
      assert.deepEqual([acts[0]!.actorId, acts[0]!.actorRole, acts[0]!.referenceType, acts[0]!.referenceId, acts[0]!.leadId], [w.sales.id, Role.SALESPERSON, "RefundRequest", r.id, w.leadId]);
    });
  });

  it("manager (in scope) and admin may raise one too; PAYMENT_REFUNDED is never used", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      assert.equal((await svc.createRequest(w.manager, w.orderId, body(w, "100"))).requestedBy.role, Role.MANAGER);
      assert.equal((await svc.createRequest(w.admin, w.orderId, body(w, "100"))).requestedBy.role, Role.ADMIN);
      assert.equal(await tx.activity.count({ where: { orderId: w.orderId, type: ActivityType.PAYMENT_REFUNDED } }), 0);
    });
  });

  it("scope: another salesperson's order and a manager outside the team look like 'not found'", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      await rejects(svc.createRequest(w.sales2, w.orderId, body(w, "100")), 404);
      await rejects(svc.createRequest(w.outsiderManager, w.orderId, body(w, "100")), 404);
      assert.equal(await tx.refundRequest.count({ where: { orderId: w.orderId } }), 0);
    });
  });

  it("a payment of another order is refused", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const other = await world(tx);
      await rejects(svc.createRequest(w.sales, w.orderId, { paymentId: other.paymentId, amount: "10", reason: "x" }), 400, /does not belong/);
    });
  });

  it("amount and reason are validated server-side: zero, negative, blank reason, above the payment, above the refundable balance", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      await rejects(svc.createRequest(w.sales, w.orderId, body(w, "0.00")), 400, /greater than 0/);
      await rejects(svc.createRequest(w.sales, w.orderId, body(w, "-5")), 400);
      await rejects(svc.createRequest(w.sales, w.orderId, { ...body(w, "10"), reason: "   " }), 400, /reason/i);
      await rejects(svc.createRequest(w.sales, w.orderId, body(w, "1000.01")), 400, /exceed the payment amount/);
      await svc.createRequest(w.sales, w.orderId, body(w, "600"));
      await rejects(svc.createRequest(w.sales, w.orderId, body(w, "400.01")), 400, /Only ₹400.00 can still be refunded/);
      assert.equal(await tx.refundRequest.count({ where: { orderId: w.orderId } }), 1);
    });
  });
});

describe("eligibility: only Cashfree-collected, settled payments with their Cashfree ids", () => {
  const refused = (name: string, over: Partial<Prisma.PaymentUncheckedCreateInput>, re: RegExp) =>
    it(name, async () => {
      await inRollback(async (tx, svc) => {
        const w = await world(tx, over);
        await rejects(svc.createRequest(w.sales, w.orderId, body(w, "10")), 400, re);
        const info = await loadOrderRefundInfo(tx, w.orderId);
        assert.equal(info.payments[0]!.eligible, false);
        assert.match(info.payments[0]!.ineligibleReason ?? "", re);
      });
    });
  refused("a Shopify-collected payment", { externalSource: "SHOPIFY", externalId: `shop_${uid().slice(0, 8)}` }, /not collected through Cashfree/);
  refused("a COD payment", { externalSource: null, externalId: null, method: PaymentMethod.COD, providerPaymentId: null, metadata: undefined }, /not collected through Cashfree/);
  refused("a payment without the Cashfree payment id", { providerPaymentId: null }, /payment id is not recorded/);
  refused("a payment without the Cashfree order reference", { metadata: { cashfree: {} } }, /order reference is not recorded/);
  refused("a FAILED payment", { status: PaymentStatus.FAILED }, /Only a successful payment/);
  refused("a PENDING payment", { status: PaymentStatus.PENDING }, /Only a successful payment/);
  refused("an already REFUNDED payment", { status: PaymentStatus.REFUNDED, refundedAmount: "1000.00" }, /Only a successful payment/);

  it("PARTIALLY_REFUNDED is allowed, limited to what is left; a null refundedAmount counts as zero", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx, { status: PaymentStatus.PARTIALLY_REFUNDED, refundedAmount: "300.00" });
      await rejects(svc.createRequest(w.sales, w.orderId, body(w, "700.01")), 400, /Only ₹700.00 can still be refunded/);
      assert.equal((await svc.createRequest(w.sales, w.orderId, body(w, "700"))).remainingRefundableAmount, "0.00");
      const w2 = await world(tx, { refundedAmount: null });
      assert.equal((await svc.createRequest(w2.sales, w2.orderId, body(w2, "1000"))).amount, "1000.00");
    });
  });

  it("a payment with nothing left is not offered", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      await svc.createRequest(w.sales, w.orderId, body(w, "1000"));
      const info = await loadOrderRefundInfo(tx, w.orderId);
      assert.deepEqual([info.payments[0]!.eligible, info.payments[0]!.refundableAmount, info.payments[0]!.reservedAmount], [false, "0.00", "1000.00"]);
      await rejects(svc.createRequest(w.sales, w.orderId, body(w, "1")), 400, /Nothing is left/);
    });
  });
});

describe("reservation accounting", () => {
  it("pending and approved requests reserve their amount; a rejected one gives it back; the balance can be filled exactly", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const a = await svc.createRequest(w.sales, w.orderId, body(w, "400"));
      const b = await svc.createRequest(w.sales, w.orderId, body(w, "300"));
      await svc.approve(w.manager, b.id);
      await rejects(svc.createRequest(w.sales, w.orderId, body(w, "400")), 400, /Only ₹300.00/);
      await svc.reject(w.manager, a.id, "Not eligible");
      assert.equal((await svc.createRequest(w.sales, w.orderId, body(w, "700"))).remainingRefundableAmount, "0.00");
    });
  });

  it("several smaller requests whose sum equals the balance all fit; one more cent does not", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      for (const amt of ["250", "250", "250", "249.99"]) await svc.createRequest(w.sales, w.orderId, body(w, amt));
      await rejects(svc.createRequest(w.sales, w.orderId, body(w, "0.02")), 400);
      await svc.createRequest(w.sales, w.orderId, body(w, "0.01"));
    });
  });

  it("the order detail info uses the same arithmetic (amount - refunded - reserved)", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx, { status: PaymentStatus.PARTIALLY_REFUNDED, refundedAmount: "100.00" });
      await svc.createRequest(w.sales, w.orderId, body(w, "250"));
      const p = (await loadOrderRefundInfo(tx, w.orderId)).payments[0]!;
      assert.deepEqual([p.amount, p.refundedAmount, p.reservedAmount, p.refundableAmount, p.eligible], ["1000.00", "100.00", "250.00", "650.00", true]);
    });
  });
});

describe("approval and rejection", () => {
  it("a manager approves: status, decision actor/role/time/note and the audit event; the request leaves the pending queue", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const r = await svc.createRequest(w.sales, w.orderId, body(w, "200"));
      const done = await svc.approve(w.manager, r.id, "Verified with the customer");
      assert.deepEqual([done.status, done.decidedBy?.id, done.decidedBy?.role, done.decisionNote], ["APPROVED", w.manager.id, Role.MANAGER, "Verified with the customer"]);
      assert.ok(done.decisionAt);
      const act = await tx.activity.findFirstOrThrow({ where: { orderId: w.orderId, type: ActivityType.REFUND_APPROVED } });
      assert.deepEqual([act.actorId, act.actorRole, act.referenceType, act.referenceId], [w.manager.id, Role.MANAGER, "RefundRequest", r.id]);
      assert.equal((await svc.list(w.manager, { status: "PENDING", page: 1, pageSize: 20 })).items.length, 0);
      assert.equal((await svc.list(w.manager, { status: "APPROVED", page: 1, pageSize: 20 })).items.length, 1);
    });
  });

  it("an admin rejects with a note; a rejection without a note is refused", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const r = await svc.createRequest(w.sales, w.orderId, body(w, "200"));
      await rejects(svc.reject(w.admin, r.id, "  "), 400, /reason/i);
      const done = await svc.reject(w.admin, r.id, "Outside the return window");
      assert.deepEqual([done.status, done.decidedBy?.role, done.decisionNote], ["REJECTED", Role.ADMIN, "Outside the return window"]);
      const act = await tx.activity.findFirstOrThrow({ where: { orderId: w.orderId, type: ActivityType.REFUND_REJECTED } });
      assert.deepEqual([act.actorId, act.actorRole, act.referenceId], [w.admin.id, Role.ADMIN, r.id]);
    });
  });

  it("nobody decides their own request: a manager, or an admin, approving/rejecting what they raised is refused server-side", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const mine = await svc.createRequest(w.manager, w.orderId, body(w, "100"));
      await rejects(svc.approve(w.manager, mine.id), 403, /own refund request/);
      await rejects(svc.reject(w.manager, mine.id, "no"), 403, /own refund request/);
      const adminOwn = await svc.createRequest(w.admin, w.orderId, body(w, "100"));
      await rejects(svc.approve(w.admin, adminOwn.id), 403, /own refund request/);
      // ... but another authorized person can
      assert.equal((await svc.approve(w.admin2, mine.id)).status, "APPROVED");
      assert.equal((await svc.approve(w.manager, adminOwn.id)).status, "APPROVED");
    });
  });

  it("a salesperson can not decide or list; a manager outside the team can not see or decide the request", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const r = await svc.createRequest(w.sales, w.orderId, body(w, "100"));
      await rejects(svc.approve(w.sales, r.id), 403);
      await rejects(svc.reject(w.sales, r.id, "x"), 403);
      await rejects(svc.list(w.sales, { status: "PENDING", page: 1, pageSize: 20 }), 403);
      await rejects(svc.approve(w.outsiderManager, r.id), 404);
      assert.equal((await svc.list(w.outsiderManager, { status: "PENDING", page: 1, pageSize: 20 })).items.length, 0);
      assert.equal((await svc.list(w.manager, { status: "PENDING", page: 1, pageSize: 20 })).items.length, 1);
      assert.equal((await svc.list(w.admin, { status: "PENDING", page: 1, pageSize: 20 })).items.some((i) => i.id === r.id), true);
    });
  });

  it("decisions are final: approve twice, reject after approve, approve after reject are all refused and change nothing", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const a = await svc.createRequest(w.sales, w.orderId, body(w, "100"));
      await svc.approve(w.manager, a.id);
      await rejects(svc.approve(w.admin, a.id), 409, /already approved/);
      await rejects(svc.reject(w.admin, a.id, "changed my mind"), 409, /already approved/);
      const b = await svc.createRequest(w.sales, w.orderId, body(w, "100"));
      await svc.reject(w.manager, b.id, "no");
      await rejects(svc.approve(w.admin, b.id), 409, /already rejected/);
      await rejects(svc.reject(w.admin, b.id, "again"), 409);
      const rows = await tx.refundRequest.findMany({ where: { orderId: w.orderId }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(rows.map((r) => r.status), [RefundRequestStatus.APPROVED, RefundRequestStatus.REJECTED]);
      assert.equal(await tx.activity.count({ where: { orderId: w.orderId, type: { in: [ActivityType.REFUND_APPROVED, ActivityType.REFUND_REJECTED] } } }), 2);
    });
  });

  it("the pending badge counts only what this user could act on (in scope, not their own)", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      await svc.createRequest(w.sales, w.orderId, body(w, "100"));
      await svc.createRequest(w.manager, w.orderId, body(w, "100"));
      assert.equal((await svc.pendingCount(w.manager)).count, 1);
      assert.equal((await svc.pendingCount(w.outsiderManager)).count, 0);
      assert.ok((await svc.pendingCount(w.admin)).count >= 2);
      await rejects(svc.pendingCount(w.sales), 403);
    });
  });
});

describe("a duplicate submission is not a second request", () => {
  it("the same submission key returns the request already created; a different payload under that key is a conflict", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const key = `sub-${uid()}`;
      const a = await svc.createRequest(w.sales, w.orderId, body(w, "100", { submissionKey: key }));
      const b = await svc.createRequest(w.sales, w.orderId, body(w, "100", { submissionKey: key }));
      assert.equal(a.id, b.id);
      assert.equal(await tx.refundRequest.count({ where: { orderId: w.orderId } }), 1);
      assert.equal(await tx.activity.count({ where: { orderId: w.orderId, type: ActivityType.REFUND_REQUESTED } }), 1);
      await rejects(svc.createRequest(w.sales, w.orderId, body(w, "200", { submissionKey: key })), 409);
    });
  });
});

describe("approval is only a decision: no money moves, no provider is contacted", () => {
  it("approving leaves Payment.status / refundedAmount / refundedAt and Order.status exactly as they were", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx, { status: PaymentStatus.PARTIALLY_REFUNDED, refundedAmount: "100.00", refundedAt: new Date("2026-09-01T00:00:00Z") });
      const snapshot = async () => {
        const p = await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId } });
        const o = await tx.order.findUniqueOrThrow({ where: { id: w.orderId } });
        return JSON.stringify({ ps: p.status, pr: p.refundedAmount?.toString(), pt: p.refundedAt?.toISOString(), pa: p.amount.toString(), pm: p.metadata, os: o.status, ot: o.totalAmount.toString() });
      };
      const before = await snapshot();
      const calls: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = ((input: unknown) => {
        calls.push(String(input));
        throw new Error("no network call is allowed in the refund approval workflow");
      }) as typeof fetch;
      try {
        const r = await svc.createRequest(w.sales, w.orderId, body(w, "300"));
        await svc.approve(w.manager, r.id);
        const r2 = await svc.createRequest(w.sales, w.orderId, body(w, "200"));
        await svc.reject(w.manager, r2.id, "no");
      } finally {
        globalThis.fetch = realFetch;
      }
      assert.deepEqual(calls, []);
      assert.equal(await snapshot(), before);
      assert.equal(await tx.activity.count({ where: { orderId: w.orderId, type: ActivityType.PAYMENT_REFUNDED } }), 0);
    });
  });

  it("the refund module contains no Cashfree client, no refund endpoint and no network call", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith("test.ts") && !f.endsWith("db-test.ts"));
    assert.ok(sources.length >= 6);
    for (const f of sources) {
      const code = readFileSync(path.join(dir, f), "utf8").replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(code, /cashfree\.client|CashfreeClient|requestJson|\bfetch\s*\(|\/refunds(?![.\w-])|x-client-secret|axios/i, f);
    }
  });
});

describe("concurrent requests can never reserve more than the refundable balance", () => {
  // Real, simultaneous transactions: the order advisory lock serialises them. Committed under unique ids, then deleted.
  async function cleanup(w: World | null, extraUsers: string[]) {
    if (!w) return;
    await prisma.activity.deleteMany({ where: { orderId: w.orderId } });
    await prisma.refundRequest.deleteMany({ where: { orderId: w.orderId } });
    await prisma.payment.deleteMany({ where: { orderId: w.orderId } });
    await prisma.order.deleteMany({ where: { id: w.orderId } });
    await prisma.lead.deleteMany({ where: { id: w.leadId } });
    await prisma.groupMember.deleteMany({ where: { groupId: w.groupId } });
    await prisma.group.deleteMany({ where: { id: w.groupId } });
    await prisma.source.deleteMany({ where: { id: w.sourceId } });
    await prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
  }
  const userIds = (w: World) => [w.sales, w.sales2, w.manager, w.manager2, w.outsiderManager, w.admin, w.admin2].map((u) => u.id);

  it("₹700 and ₹500 at the same time against ₹1,000: exactly one succeeds and ₹1,200 is never reserved", async () => {
    let w: World | null = null;
    try {
      w = await prisma.$transaction((tx) => world(tx), { timeout: 60_000 });
      const svc = new RefundsService(prisma);
      const results = await Promise.allSettled([svc.createRequest(w.sales, w.orderId, body(w, "700")), svc.createRequest(w.sales, w.orderId, body(w, "500"))]);
      const ok = results.filter((r) => r.status === "fulfilled");
      assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.status)));
      const rows = await prisma.refundRequest.findMany({ where: { orderId: w.orderId } });
      const reserved = rows.reduce((s, r) => s + Number(r.amount), 0);
      assert.ok(reserved <= 1000, `reserved ${reserved}`);
      assert.equal(rows.length, 1);
    } finally {
      await cleanup(w, w ? userIds(w) : []);
    }
  });

  it("four simultaneous ₹400 requests: exactly two fit", async () => {
    let w: World | null = null;
    try {
      w = await prisma.$transaction((tx) => world(tx), { timeout: 60_000 });
      const svc = new RefundsService(prisma);
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => svc.createRequest(w!.sales, w!.orderId, body(w!, "400"))));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
      assert.equal((await prisma.refundRequest.findMany({ where: { orderId: w.orderId } })).reduce((s, r) => s + Number(r.amount), 0), 800);
    } finally {
      await cleanup(w, w ? userIds(w) : []);
    }
  });

  it("two simultaneous decisions on one request: exactly one wins, one audit event", async () => {
    let w: World | null = null;
    try {
      w = await prisma.$transaction((tx) => world(tx), { timeout: 60_000 });
      const svc = new RefundsService(prisma);
      const r = await svc.createRequest(w.sales, w.orderId, body(w, "100"));
      const results = await Promise.allSettled([svc.approve(w.manager, r.id), svc.reject(w.admin, r.id, "no"), svc.approve(w.admin2, r.id)]);
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(await prisma.activity.count({ where: { orderId: w.orderId, type: { in: [ActivityType.REFUND_APPROVED, ActivityType.REFUND_REJECTED] } } }), 1);
    } finally {
      await cleanup(w, w ? userIds(w) : []);
    }
  });
});
