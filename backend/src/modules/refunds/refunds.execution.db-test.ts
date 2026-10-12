// Refund EXECUTION against the real schema, with a FAKE Cashfree refund API. Run with: npm run test:db
// No real Cashfree call can happen here: the service is only ever given the fake below (and the default client is never constructed).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivityType, OrderSource, OrderStatus, PaymentMethod, PaymentStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ProviderHttpError, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { loadCashfreeConfig, type CashfreeConfig } from "../cashfree/cashfree.config.js";
import type { CashfreeRefund } from "../cashfree/cashfree.client.js";
import RefundsService from "./refunds.service.js";
import RefundExecutionService, { applyRefundOutcome, refundIdFor, type RefundApi } from "./refunds.execution.js";

class Rollback extends Error {}
after(() => prisma.$disconnect());
const uid = () => randomUUID();
const SANDBOX: CashfreeConfig = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret-not-real" });
const PRODUCTION: CashfreeConfig = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "production", CASHFREE_CLIENT_ID: "PROD_APP", CASHFREE_CLIENT_SECRET: "prod-secret-not-real" });
const CF_ORDER = "CFPay_testorder_1";

interface Fake {
  api: RefundApi;
  creates: { orderId: string; body: { refund_amount: number; refund_id: string; refund_note: string; refund_speed: string }; key: string }[];
  gets: { orderId: string; refundId: string }[];
  /** What createRefund answers / what getRefund answers (set per test). */
  onCreate: (orderId: string, body: any) => Promise<CashfreeRefund>;
  onGet: (orderId: string, refundId: string) => Promise<CashfreeRefund>;
}
const refundAnswer = (over: Partial<CashfreeRefund> = {}): CashfreeRefund => ({ cfRefundId: "CFR-1", refundId: "x", orderId: CF_ORDER, refundStatus: "PENDING", refundAmount: "100", refundCurrency: "INR", statusDescription: null, refundArn: null, processedAt: null, ...over });
function fake(): Fake {
  const f: Fake = {
    creates: [],
    gets: [],
    onCreate: async (_o, body) => refundAnswer({ refundId: body.refund_id, refundAmount: String(body.refund_amount) }),
    onGet: async (_o, refundId) => refundAnswer({ refundId }),
    api: undefined as unknown as RefundApi,
  };
  f.api = {
    createRefund: async (orderId, body, key) => { f.creates.push({ orderId, body, key }); return f.onCreate(orderId, body); },
    getRefund: async (orderId, refundId) => { f.gets.push({ orderId, refundId }); return f.onGet(orderId, refundId); },
  };
  return f;
}
const exec = (runner: TxRunner, f: Fake, config: CashfreeConfig = SANDBOX, now?: () => Date) => new RefundExecutionService(runner, { config: () => config, client: () => f.api, env: {}, now });

async function inRollback(fn: (tx: Db, runner: TxRunner) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx, { $transaction: (cb) => cb(tx) }); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

type U = { id: string; username: string; role: Role };
const as = (u: { id: string; username: string }, role: Role): U => ({ id: u.id, username: u.username, role });
const mk = (tx: Db, name: string, role: Role) => tx.user.create({ data: { name, username: `${name.toLowerCase()}-${uid()}`, role }, select: { id: true, username: true } });
interface World { sales: U; manager: U; manager2: U; outsider: U; admin: U; orderId: string; paymentId: string; leadId: string; groupId: string; sourceId: string }
async function world(tx: Db, amount = "1000.00", pay: Partial<Prisma.PaymentUncheckedCreateInput> = {}): Promise<World> {
  const [s, m, m2, om, a] = await Promise.all([mk(tx, "Sales", Role.SALESPERSON), mk(tx, "Mgr", Role.MANAGER), mk(tx, "Mgr2", Role.MANAGER), mk(tx, "Outsider", Role.MANAGER), mk(tx, "Admin", Role.ADMIN)]);
  const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: m.id }, select: { id: true } });
  await tx.groupMember.create({ data: { groupId: group.id, userId: s.id, joinedAt: new Date(), isActive: true } });
  await tx.groupMember.create({ data: { groupId: group.id, userId: m2.id, joinedAt: new Date(), isActive: true } });
  const source = await tx.source.create({ data: { name: "Website", code: `web-${uid()}` }, select: { id: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", sourceId: source.id, ownerId: s.id, groupId: group.id }, select: { id: true } });
  const order = await tx.order.create({ data: { orderNumber: `RX-${uid().slice(0, 8)}`, leadId: lead.id, source: OrderSource.SALESPERSON, status: OrderStatus.CANCELLED, totalAmount: amount, createdById: s.id }, select: { id: true } });
  const p = await tx.payment.create({
    data: { orderId: order.id, provider: "Cashfree", providerPaymentId: "cfpay_1", amount, method: PaymentMethod.PAYMENT_LINK, status: PaymentStatus.SUCCESS, externalSource: "CASHFREE", externalId: `l_${uid().slice(0, 12)}`, paidAt: new Date(), metadata: { cashfree: { cashfreeOrderId: CF_ORDER } }, ...pay },
    select: { id: true },
  });
  return { sales: as(s, Role.SALESPERSON), manager: as(m, Role.MANAGER), manager2: as(m2, Role.MANAGER), outsider: as(om, Role.MANAGER), admin: as(a, Role.ADMIN), orderId: order.id, paymentId: p.id, leadId: lead.id, groupId: group.id, sourceId: source.id };
}
/** An APPROVED request (raised by the telecaller, approved by the admin). */
async function approved(runner: TxRunner, w: World, amount: string) {
  const svc = new RefundsService(runner);
  const r = await svc.createRequest(w.sales, w.orderId, { paymentId: w.paymentId, amount, reason: "Customer returned the product" });
  await svc.approve(w.admin, r.id);
  return r;
}
const rejects = (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => { assert.equal(e.statusCode, status, e.message); if (re) assert.match(e.message, re); return true; });
const pay = (tx: Db, id: string) => tx.payment.findUniqueOrThrow({ where: { id } });
const reqRow = (tx: Db, id: string) => tx.refundRequest.findUniqueOrThrow({ where: { id } });

describe("who and when", () => {
  it("salesperson denied; the requester can not execute their own; an out-of-scope manager gets 'not found'; admin and an in-scope manager are allowed", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx);
      const r = await approved(runner, w, "100");
      const f = fake();
      await rejects(exec(runner, f).execute(w.sales, r.id), 403);
      await rejects(exec(runner, f).execute(w.outsider, r.id), 404);
      assert.equal(f.creates.length, 0);
      assert.equal((await exec(runner, f).execute(w.manager, r.id)).sentToProvider, true);
      const own = await new RefundsService(runner).createRequest(w.manager, w.orderId, { paymentId: w.paymentId, amount: "50", reason: "mine" });
      await new RefundsService(runner).approve(w.admin, own.id);
      await rejects(exec(runner, f).execute(w.manager, own.id), 403, /your own request/);
    });
  });

  it("PENDING and REJECTED requests can not be executed and never reach Cashfree", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx);
      const svc = new RefundsService(runner);
      const pending = await svc.createRequest(w.sales, w.orderId, { paymentId: w.paymentId, amount: "100", reason: "x" });
      const rejected = await svc.createRequest(w.sales, w.orderId, { paymentId: w.paymentId, amount: "100", reason: "y" });
      await svc.reject(w.admin, rejected.id, "no");
      const f = fake();
      await rejects(exec(runner, f).execute(w.admin, pending.id), 409, /approved/);
      await rejects(exec(runner, f).execute(w.admin, rejected.id), 409, /rejected/);
      assert.deepEqual([f.creates.length, f.gets.length], [0, 0]);
    });
  });

  it("production is refused (no provider call) unless switched on explicitly", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx);
      const r = await approved(runner, w, "100");
      const f = fake();
      await rejects(exec(runner, f, PRODUCTION).execute(w.admin, r.id), 403, /sandbox/);
      assert.equal(f.creates.length, 0);
      assert.equal((await reqRow(tx, r.id)).executionStatus, null);
    });
  });
});

describe("execution: PROCESSING until Cashfree confirms", () => {
  it("sends exactly the right refund to the Cashfree ORDER id and marks PROCESSING - payment, order and accounting untouched", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, "100.00");
      const r = await approved(runner, w, "100");
      const f = fake();
      const before = await pay(tx, w.paymentId);
      const out = await exec(runner, f).execute(w.admin, r.id);
      assert.equal(out.request.executionStatus, "PROCESSING");
      assert.equal(f.creates.length, 1);
      const c = f.creates[0]!;
      assert.equal(c.orderId, CF_ORDER, "the Cashfree order id - not the payment id, not the link id");
      assert.deepEqual(c.body, { refund_amount: 100, refund_id: refundIdFor(r.id), refund_note: c.body.refund_note, refund_speed: "STANDARD" });
      assert.match(c.body.refund_note, /^CRM refund RX-/);
      assert.equal(c.key, r.id, "the request id is the idempotency key");
      const after = await pay(tx, w.paymentId);
      assert.deepEqual([after.status, after.refundedAmount, after.refundedAt], [before.status, before.refundedAmount, before.refundedAt]);
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: w.orderId } })).status, OrderStatus.CANCELLED);
      const row = await reqRow(tx, r.id);
      assert.deepEqual([row.status, row.executionStatus, row.refundId, row.cfRefundId, row.providerStatus, row.executedById, row.executionAttempts], ["APPROVED", "PROCESSING", refundIdFor(r.id), "CFR-1", "PENDING", w.admin.id, 1]);
      const started = await tx.activity.findFirstOrThrow({ where: { orderId: w.orderId, type: ActivityType.REFUND_EXECUTION_STARTED } });
      assert.deepEqual([started.actorId, started.actorRole, started.referenceType, started.referenceId], [w.admin.id, Role.ADMIN, "RefundRequest", r.id]);
    });
  });

  it("even a SUCCESS in the create answer does not complete the refund: only the status lookup does", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, "100.00");
      const r = await approved(runner, w, "100");
      const f = fake();
      f.onCreate = async (_o, body) => refundAnswer({ refundId: body.refund_id, refundStatus: "SUCCESS", refundAmount: "100" });
      assert.equal((await exec(runner, f).execute(w.admin, r.id)).request.executionStatus, "PROCESSING");
      assert.equal((await pay(tx, w.paymentId)).refundedAmount, null);
      f.onGet = async (_o, refundId) => refundAnswer({ refundId, refundStatus: "SUCCESS", refundAmount: "100", processedAt: "2026-10-07T05:30:00+05:30" });
      const done = await exec(runner, f).refresh(w.manager, r.id);
      assert.equal(done.executionStatus, "COMPLETED");
      const p = await pay(tx, w.paymentId);
      assert.deepEqual([p.refundedAmount?.toString(), p.status], ["100", PaymentStatus.REFUNDED]);
      assert.ok(p.refundedAt);
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: w.orderId } })).status, OrderStatus.CANCELLED);
      const types = (await tx.activity.findMany({ where: { orderId: w.orderId } })).map((a) => a.type);
      for (const t of [ActivityType.REFUND_REQUESTED, ActivityType.REFUND_APPROVED, ActivityType.REFUND_EXECUTION_STARTED, ActivityType.REFUND_COMPLETED, ActivityType.PAYMENT_REFUNDED]) assert.ok(types.includes(t), t);
      const accounting = await tx.activity.findFirstOrThrow({ where: { orderId: w.orderId, type: ActivityType.PAYMENT_REFUNDED } });
      assert.equal(accounting.actorId, w.manager.id);
    });
  });

  it("PENDING / ONHOLD at Cashfree keep it PROCESSING; a repeated refresh after completion changes nothing (no double counting)", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, "100.00");
      const r = await approved(runner, w, "100");
      const f = fake();
      await exec(runner, f).execute(w.admin, r.id);
      for (const s of ["PENDING", "ONHOLD", "PENDING_APPROVAL"]) {
        f.onGet = async (_o, refundId) => refundAnswer({ refundId, refundStatus: s });
        assert.equal((await exec(runner, f).refresh(w.admin, r.id)).executionStatus, "PROCESSING", s);
      }
      assert.equal((await pay(tx, w.paymentId)).refundedAmount, null);
      f.onGet = async (_o, refundId) => refundAnswer({ refundId, refundStatus: "SUCCESS" });
      await exec(runner, f).refresh(w.admin, r.id);
      await exec(runner, f).refresh(w.admin, r.id);
      await applyRefundOutcome(tx, r.id, refundAnswer({ refundId: refundIdFor(r.id), refundStatus: "SUCCESS" }), { source: "USER" as never, now: new Date(), allowComplete: true });
      assert.equal((await pay(tx, w.paymentId)).refundedAmount?.toString(), "100");
      assert.equal(await tx.activity.count({ where: { orderId: w.orderId, type: ActivityType.PAYMENT_REFUNDED } }), 1);
    });
  });

  it("a completed request can not be executed again; a processing one is returned without a second provider call", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, "100.00");
      const r = await approved(runner, w, "100");
      const f = fake();
      await exec(runner, f).execute(w.admin, r.id);
      const again = await exec(runner, f).execute(w.manager, r.id);
      assert.deepEqual([again.sentToProvider, again.request.executionStatus, f.creates.length], [false, "PROCESSING", 1]);
      f.onGet = async (_o, refundId) => refundAnswer({ refundId, refundStatus: "SUCCESS" });
      await exec(runner, f).refresh(w.admin, r.id);
      await rejects(exec(runner, f).execute(w.admin, r.id), 409, /already been completed/);
      assert.equal(f.creates.length, 1);
    });
  });
});

describe("accounting only on COMPLETED", () => {
  it("partial refunds accumulate (PARTIALLY_REFUNDED) until the payment is fully refunded (REFUNDED); a completed request stops reserving", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, "1000.00");
      const f = fake();
      f.onGet = async (_o, refundId) => refundAnswer({ refundId, refundStatus: "SUCCESS", refundAmount: String(refundAmounts.get(refundId)) });
      const refundAmounts = new Map<string, number>();
      let total = 0;
      for (const [amt, expectStatus] of [[250, "PARTIALLY_REFUNDED"], [300, "PARTIALLY_REFUNDED"], [450, "REFUNDED"]] as const) {
        const r = await approved(runner, w, String(amt));
        refundAmounts.set(refundIdFor(r.id), amt);
        assert.equal((await pay(tx, w.paymentId)).refundedAmount === null || Number((await pay(tx, w.paymentId)).refundedAmount) === total, true, "approved alone changes nothing");
        await exec(runner, f).execute(w.admin, r.id);
        assert.equal(Number((await pay(tx, w.paymentId)).refundedAmount ?? 0), total, "PROCESSING changes nothing");
        await exec(runner, f).refresh(w.admin, r.id);
        total += amt;
        const p = await pay(tx, w.paymentId);
        assert.deepEqual([Number(p.refundedAmount), p.status], [total, expectStatus]);
      }
      // nothing left: a new request is refused (the completed ones do not reserve, the payment is fully refunded)
      await rejects(new RefundsService(runner).createRequest(w.sales, w.orderId, { paymentId: w.paymentId, amount: "1", reason: "x" }), 400);
    });
  });

  it("a completed refund frees its reservation (it is in refundedAmount now) - the balance is neither double counted nor lost", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, "1000.00");
      const f = fake();
      const r = await approved(runner, w, "300");
      f.onGet = async (_o, refundId) => refundAnswer({ refundId, refundStatus: "SUCCESS", refundAmount: "300" });
      await exec(runner, f).execute(w.admin, r.id);
      await exec(runner, f).refresh(w.admin, r.id);
      const svc = new RefundsService(runner);
      await rejects(svc.createRequest(w.sales, w.orderId, { paymentId: w.paymentId, amount: "700.01", reason: "x" }), 400, /Only ₹700\.00/);
      assert.equal((await svc.createRequest(w.sales, w.orderId, { paymentId: w.paymentId, amount: "700", reason: "x" })).remainingRefundableAmount, "0.00");
    });
  });

  it("an over-refund is never applied: a confirmation that would exceed the payment, or with a different amount, stays PROCESSING", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, "100.00");
      const r = await approved(runner, w, "100");
      const f = fake();
      await exec(runner, f).execute(w.admin, r.id);
      f.onGet = async (_o, refundId) => refundAnswer({ refundId, refundStatus: "SUCCESS", refundAmount: "90" });
      assert.equal((await exec(runner, f).refresh(w.admin, r.id)).executionStatus, "PROCESSING");
      assert.equal((await pay(tx, w.paymentId)).refundedAmount, null);
      await tx.payment.update({ where: { id: w.paymentId }, data: { refundedAmount: "50.00" } });
      f.onGet = async (_o, refundId) => refundAnswer({ refundId, refundStatus: "SUCCESS", refundAmount: "100" });
      assert.equal((await exec(runner, f).refresh(w.admin, r.id)).executionStatus, "PROCESSING");
      assert.equal(Number((await pay(tx, w.paymentId)).refundedAmount), 50);
    });
  });
});

describe("failures and unknown outcomes", () => {
  it("a synchronous rejection -> FAILED (sanitised), nothing moves; a retry reuses the SAME refund id and the same idempotency key", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, "100.00");
      const r = await approved(runner, w, "100");
      const f = fake();
      f.onCreate = async () => { throw new ProviderHttpError("CASHFREE", 400, "refund_amount is more than the transaction amount", false); };
      const failed = await exec(runner, f).execute(w.admin, r.id);
      assert.equal(failed.request.executionStatus, "FAILED");
      assert.match(failed.request.failureReason!, /Cashfree rejected the refund/);
      const p = await pay(tx, w.paymentId);
      assert.deepEqual([p.status, p.refundedAmount, p.refundedAt], [PaymentStatus.SUCCESS, null, null]);
      assert.equal((await reqRow(tx, r.id)).status, "APPROVED");
      assert.ok(await tx.activity.findFirst({ where: { orderId: w.orderId, type: ActivityType.REFUND_EXECUTION_FAILED } }));
      f.onCreate = async (_o, body) => refundAnswer({ refundId: body.refund_id });
      const retry = await exec(runner, f).execute(w.admin, r.id);
      assert.equal(retry.request.executionStatus, "PROCESSING");
      assert.equal(f.creates.length, 2);
      assert.equal(f.creates[0]!.body.refund_id, f.creates[1]!.body.refund_id);
      assert.deepEqual([f.creates[0]!.key, f.creates[1]!.key], [r.id, r.id]);
      assert.equal((await reqRow(tx, r.id)).executionAttempts, 2);
    });
  });

  it("a timeout does NOT fail or retry: it stays PROCESSING, creates no second refund id, and a later status read recovers it", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, "100.00");
      const r = await approved(runner, w, "100");
      const f = fake();
      f.onCreate = async () => { throw new ProviderHttpError("CASHFREE", null, "The provider did not respond in time", true); };
      f.onGet = async () => { throw new ProviderHttpError("CASHFREE", 404, "something is not found", false); };
      const out = await exec(runner, f).execute(w.admin, r.id);
      assert.equal(out.request.executionStatus, "PROCESSING");
      assert.equal(f.creates.length, 1);
      assert.equal((await pay(tx, w.paymentId)).refundedAmount, null);
      const again = await exec(runner, f).execute(w.admin, r.id);
      assert.deepEqual([again.sentToProvider, f.creates.length], [false, 1], "a second execute never sends a second refund");
      f.onGet = async (_o, refundId) => refundAnswer({ refundId, refundStatus: "SUCCESS", refundAmount: "100" });
      assert.equal((await exec(runner, f).refresh(w.admin, r.id)).executionStatus, "COMPLETED");
      assert.equal(f.creates.length, 1);
    });
  });

  it("a duplicate refund id (409) is recovered by READING the refund, not by creating another", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, "100.00");
      const r = await approved(runner, w, "100");
      const f = fake();
      f.onCreate = async () => { throw new ProviderHttpError("CASHFREE", 409, "duplicate refund id", false); };
      f.onGet = async (_o, refundId) => refundAnswer({ refundId, refundStatus: "PENDING" });
      const out = await exec(runner, f).execute(w.admin, r.id);
      assert.equal(out.request.executionStatus, "PROCESSING");
      assert.deepEqual([f.creates.length, f.gets.length], [1, 1]);
      assert.equal(out.request.cfRefundId, "CFR-1");
    });
  });

  it("a malformed / unreadable provider answer never completes anything", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, "100.00");
      const r = await approved(runner, w, "100");
      const f = fake();
      f.onCreate = async () => { throw new Error("Cashfree answered without refund details"); };
      f.onGet = async () => { throw new Error("Cashfree answered without refund details"); };
      const out = await exec(runner, f).execute(w.admin, r.id);
      assert.equal(out.request.executionStatus, "PROCESSING");
      assert.equal((await pay(tx, w.paymentId)).refundedAmount, null);
    });
  });

  it("CANCELLED / REJECTED at Cashfree -> FAILED (retryable); a refund Cashfree does not know about is only called never-created after the grace period", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, "100.00");
      const r = await approved(runner, w, "100");
      const f = fake();
      let clock = new Date("2026-10-07T10:00:00Z");
      f.onCreate = async () => { throw new ProviderHttpError("CASHFREE", 502, "bad gateway", true); };
      f.onGet = async () => { throw new ProviderHttpError("CASHFREE", 404, "something is not found", false); };
      await exec(runner, f, SANDBOX, () => clock).execute(w.admin, r.id);
      assert.equal((await exec(runner, f, SANDBOX, () => clock).refresh(w.admin, r.id)).executionStatus, "PROCESSING", "within the grace period");
      clock = new Date(clock.getTime() + 10 * 60_000);
      assert.equal((await exec(runner, f, SANDBOX, () => clock).refresh(w.admin, r.id)).executionStatus, "FAILED", "after it: never created, safe to retry");
      f.onCreate = async (_o, b) => refundAnswer({ refundId: b.refund_id });
      f.onGet = async (_o, refundId) => refundAnswer({ refundId, refundStatus: "CANCELLED", statusDescription: "cancelled by bank" });
      assert.equal((await exec(runner, f).execute(w.admin, r.id)).request.executionStatus, "PROCESSING");
      assert.equal((await exec(runner, f).refresh(w.admin, r.id)).executionStatus, "FAILED");
      assert.equal((await pay(tx, w.paymentId)).refundedAmount, null);
    });
  });
});

describe("concurrency (real simultaneous transactions)", () => {
  async function cleanup(w: World | null, extra: string[] = []) {
    if (!w) return;
    await prisma.activity.deleteMany({ where: { orderId: w.orderId } });
    await prisma.refundRequest.deleteMany({ where: { orderId: w.orderId } });
    await prisma.payment.deleteMany({ where: { orderId: w.orderId } });
    await prisma.order.deleteMany({ where: { id: w.orderId } });
    await prisma.lead.deleteMany({ where: { id: w.leadId } });
    await prisma.groupMember.deleteMany({ where: { groupId: w.groupId } });
    await prisma.group.deleteMany({ where: { id: w.groupId } });
    await prisma.source.deleteMany({ where: { id: w.sourceId } });
    await prisma.user.deleteMany({ where: { id: { in: [w.sales.id, w.manager.id, w.manager2.id, w.outsider.id, w.admin.id, ...extra] } } });
  }

  it("three simultaneous executes of one approved refund: exactly ONE Cashfree create, one refund_id", async () => {
    let w: World | null = null;
    try {
      w = await prisma.$transaction((tx) => world(tx, "100.00"), { timeout: 60_000 });
      const r = await approved(prisma, w, "100");
      const f = fake();
      f.onCreate = async (_o, body) => { await new Promise((res) => setTimeout(res, 150)); return refundAnswer({ refundId: body.refund_id }); };
      const svc = exec(prisma, f);
      const results = await Promise.allSettled([svc.execute(w.admin, r.id), svc.execute(w.manager, r.id), svc.execute(w.admin, r.id)]);
      assert.equal(f.creates.length, 1, JSON.stringify(results.map((x) => x.status)));
      assert.equal(results.filter((x) => x.status === "fulfilled" && x.value.sentToProvider).length, 1);
      assert.equal((await reqRow(prisma as unknown as Db, r.id)).executionAttempts, 1);
      assert.equal((await reqRow(prisma as unknown as Db, r.id)).refundId, refundIdFor(r.id));
    } finally {
      await cleanup(w);
    }
  });

  it("two approved refunds of ₹600 and ₹500 against ₹1,000 can not both exist, and executing/refreshing concurrently never exceeds the payment", async () => {
    let w: World | null = null;
    try {
      w = await prisma.$transaction((tx) => world(tx, "1000.00"), { timeout: 60_000 });
      const svc = new RefundsService(prisma);
      const first = await Promise.allSettled([svc.createRequest(w.sales, w.orderId, { paymentId: w.paymentId, amount: "600", reason: "a" }), svc.createRequest(w.sales, w.orderId, { paymentId: w.paymentId, amount: "500", reason: "b" })]);
      assert.equal(first.filter((x) => x.status === "fulfilled").length, 1);
      const ok = (first.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<{ id: string; amount: string }>).value;
      await svc.approve(w.admin, ok.id);
      const f = fake();
      f.onGet = async (_o, refundId) => refundAnswer({ refundId, refundStatus: "SUCCESS", refundAmount: ok.amount });
      const x = exec(prisma, f);
      await x.execute(w.admin, ok.id);
      await Promise.allSettled([x.refresh(w.admin, ok.id), x.refresh(w.manager, ok.id), x.refresh(w.admin, ok.id)]);
      const p = await prisma.payment.findUniqueOrThrow({ where: { id: w.paymentId } });
      assert.equal(Number(p.refundedAmount), Number(ok.amount), "counted exactly once");
      assert.ok(Number(p.refundedAmount) <= 1000);
      assert.equal(await prisma.activity.count({ where: { orderId: w.orderId, type: ActivityType.PAYMENT_REFUNDED } }), 1);
    } finally {
      await cleanup(w);
    }
  });
});
