// Refund eligibility / lookup / execution for EVERY prepaid Cashfree payment - CRM-created and Shopify-synced - against the real schema.
// Run with: npm run test:db. Functional tests run in one rolled-back transaction; no real Cashfree or Shopify call is ever made (fakes only).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivityType, OrderSource, OrderStatus, PaymentMethod, PaymentStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Db, TxRunner } from "../integrations/integrations.common.js";
import { loadCashfreeConfig, type CashfreeConfig } from "../cashfree/cashfree.config.js";
import type { CashfreeOrderPayment, CashfreeRefund } from "../cashfree/cashfree.client.js";
import { codOrderNode, money, normalized, orderNode, rawLineItem, rawTransaction } from "../shopify/shopify.fixtures.js";
import { mapOrder } from "../shopify/shopify.mapper.js";
import { upsertOrder } from "../shopify/shopify.persist.js";
import RefundsService, { loadOrderRefundInfo } from "./refunds.service.js";
import RefundExecutionService, { type RefundApi } from "./refunds.execution.js";
import CashfreeIdResolutionService, { type ShopifyReceipt } from "./refunds.resolve.js";

class Rollback extends Error {}
after(() => prisma.$disconnect());
const uid = () => randomUUID();
const SANDBOX: CashfreeConfig = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret-not-real" });

async function inRollback(fn: (tx: Db, runner: TxRunner) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx, { $transaction: (cb) => cb(tx) }); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

type U = { id: string; username: string; role: Role };
const as = (u: { id: string; username: string }, role: Role): U => ({ id: u.id, username: u.username, role });
const mk = (tx: Db, name: string, role: Role) => tx.user.create({ data: { name, username: `${name.toLowerCase()}-${uid()}`, role }, select: { id: true, username: true } });

async function setup(tx: Db) {
  const [s, s2, m, a] = await Promise.all([mk(tx, "Sales", Role.SALESPERSON), mk(tx, "Sales2", Role.SALESPERSON), mk(tx, "Mgr", Role.MANAGER), mk(tx, "Admin", Role.ADMIN)]);
  const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: m.id }, select: { id: true } });
  await tx.groupMember.create({ data: { groupId: group.id, userId: s.id, joinedAt: new Date(), isActive: true } });
  const source = await tx.source.create({ data: { name: "Website", code: `web-${uid()}` }, select: { id: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", sourceId: source.id, ownerId: s.id, groupId: group.id }, select: { id: true } });
  return { sales: as(s, Role.SALESPERSON), sales2: as(s2, Role.SALESPERSON), manager: as(m, Role.MANAGER), admin: as(a, Role.ADMIN), leadId: lead.id };
}

/**
 * One order (CRM- or Shopify-originated) with one payment of ₹500 and the given payment fields. A Shopify order carries Shopify's refundable amount as the sync
 * stores it (default: the payment amount; pass another amount to cap it, or null for "never read").
 */
async function orderWith(tx: Db, leadId: string, origin: "CRM" | "SHOPIFY", payment: Partial<Prisma.PaymentUncheckedCreateInput>, refundable?: string | null) {
  const snapshot = refundable === undefined ? String(payment.amount ?? "500.00") : refundable;
  const order = await tx.order.create({
    data: { orderNumber: `RX-${uid().slice(0, 8)}`, leadId, source: origin === "SHOPIFY" ? OrderSource.SHOPIFY : OrderSource.SALESPERSON, status: OrderStatus.CANCELLED, totalAmount: "500.00", ...(origin === "SHOPIFY" ? { externalSource: "SHOPIFY", externalId: `9${randomInt(1e9, 9e9)}${randomInt(1e5, 9e5)}`, ...(snapshot === null ? {} : { metadata: { shopifyRefundable: { amount: snapshot, currency: "INR" } } }) } : {}) },
    select: { id: true },
  });
  const p = await tx.payment.create({ data: { orderId: order.id, amount: "500.00", status: PaymentStatus.SUCCESS, method: PaymentMethod.OTHER, paidAt: new Date(), ...payment }, select: { id: true } });
  return { orderId: order.id, paymentId: p.id };
}

// What the two kinds of Cashfree payment look like in the database.
const CRM_PAID: Partial<Prisma.PaymentUncheckedCreateInput> = { provider: "Cashfree", method: PaymentMethod.PAYMENT_LINK, externalSource: "CASHFREE", externalId: "", providerPaymentId: "cfpay_crm_1", metadata: { cashfree: { cashfreeOrderId: "CFPay_crm_1" } } };
const crm = (over: Partial<Prisma.PaymentUncheckedCreateInput> = {}): Partial<Prisma.PaymentUncheckedCreateInput> => ({ ...CRM_PAID, externalId: `l_${uid().slice(0, 12)}`, ...over });
const shopifyP = (over: Partial<Prisma.PaymentUncheckedCreateInput> = {}): Partial<Prisma.PaymentUncheckedCreateInput> => ({ provider: "Cashfree", method: PaymentMethod.OTHER, externalSource: "SHOPIFY", externalId: `${randomInt(1e9, 9e9)}${randomInt(1e5, 9e5)}`, providerPaymentId: "#AWL97845.1", transactionReference: "#AWL97845.1", ...over });
const RESOLVED = { cashfree: { cashfreeOrderId: "ShOrder123", cfPaymentId: "6443901832" } };

const rejects = (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => { assert.equal(e.statusCode, status, e.message); if (re) assert.match(e.message, re); return true; });
const info = async (tx: Db, orderId: string) => (await loadOrderRefundInfo(tx, orderId)).payments[0]!;

describe("Refund availability per payment (what the order page shows)", () => {
  it("CRM-created prepaid order (Cashfree link, ids recorded) -> Refund available", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const { orderId } = await orderWith(tx, w.leadId, "CRM", crm());
      const p = await info(tx, orderId);
      assert.deepEqual([p.eligible, p.canResolve, p.ineligibleReason, p.refundableAmount], [true, false, null, "500.00"]);
    });
  });

  it("Shopify-originated prepaid order (Cashfree gateway, references verified) -> Refund available", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const { orderId } = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP({ metadata: RESOLVED }));
      const p = await info(tx, orderId);
      assert.deepEqual([p.eligible, p.canResolve, p.ineligibleReason], [true, false, null]);
    });
  });

  it("Shopify-originated prepaid order whose Cashfree references are not looked up yet -> not executable, offers the lookup", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const { orderId } = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP());
      const p = await info(tx, orderId);
      assert.deepEqual([p.eligible, p.canResolve], [false, true]);
      assert.match(p.ineligibleReason!, /has not been verified yet/);
    });
  });

  it("COD (CRM or Shopify) -> unavailable, no lookup offered", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      for (const origin of ["CRM", "SHOPIFY"] as const) {
        const { orderId } = await orderWith(tx, w.leadId, origin, origin === "SHOPIFY" ? shopifyP({ provider: "Cash on Delivery (COD)", method: PaymentMethod.COD }) : { provider: "COD", method: PaymentMethod.COD });
        const p = await info(tx, orderId);
        assert.deepEqual([p.eligible, p.canResolve], [false, false], origin);
        assert.match(p.ineligibleReason!, /cash-on-delivery/);
      }
    });
  });

  it("a request on a COD-method payment is refused with the COD reason even if its other fields look like a Cashfree payment", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const o = await orderWith(tx, w.leadId, "CRM", crm({ method: PaymentMethod.COD }));
      assert.match((await info(tx, o.orderId)).ineligibleReason!, /cash-on-delivery/);
      await rejects(new RefundsService(runnerOf(tx)).createRequest(w.sales, o.orderId, { paymentId: o.paymentId, amount: "10", reason: "x" }), 400, /cash-on-delivery/);
    });
  });

  it("unpaid order (pending / failed payment) -> unavailable", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      for (const status of [PaymentStatus.PENDING, PaymentStatus.FAILED]) {
        const a = await orderWith(tx, w.leadId, "CRM", crm({ status, paidAt: null }));
        const b = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP({ status, paidAt: null, metadata: RESOLVED }));
        for (const o of [a, b]) {
          const p = await info(tx, o.orderId);
          assert.deepEqual([p.eligible, p.canResolve], [false, false], status);
          assert.match(p.ineligibleReason!, /Only a successful payment/);
        }
      }
    });
  });

  it("already fully refunded prepaid order -> no new Refund; the completed/refunded state is reported", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      for (const make of [() => orderWith(tx, w.leadId, "CRM", crm({ status: PaymentStatus.REFUNDED, refundedAmount: "500.00", refundedAt: new Date() })), () => orderWith(tx, w.leadId, "SHOPIFY", shopifyP({ status: PaymentStatus.REFUNDED, refundedAmount: "500.00", refundedAt: new Date(), metadata: RESOLVED }))]) {
        const o = await make();
        const p = await info(tx, o.orderId);
        assert.deepEqual([p.eligible, p.status, p.refundedAmount, p.refundableAmount], [false, "REFUNDED", "500.00", "0.00"]);
        assert.match(p.ineligibleReason!, /already been fully refunded/);
        await rejects(new RefundsService(runnerOf(tx)).createRequest(w.sales, o.orderId, { paymentId: o.paymentId, amount: "1", reason: "x" }), 400, /fully refunded/);
      }
    });
  });

  it("prepaid order missing its Cashfree identifiers -> a safe unavailable state, and a request is refused", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const a = await orderWith(tx, w.leadId, "CRM", crm({ providerPaymentId: null }));
      const b = await orderWith(tx, w.leadId, "CRM", crm({ metadata: {} }));
      assert.match((await info(tx, a.orderId)).ineligibleReason!, /payment id is not recorded/);
      assert.match((await info(tx, b.orderId)).ineligibleReason!, /order reference is not recorded/);
      for (const o of [a, b]) {
        assert.equal((await info(tx, o.orderId)).eligible, false);
        await rejects(new RefundsService(runnerOf(tx)).createRequest(w.sales, o.orderId, { paymentId: o.paymentId, amount: "10", reason: "x" }), 400);
      }
    });
  });
});

const runnerOf = (tx: Db): TxRunner => ({ $transaction: (cb) => cb(tx) });

describe("requesting a refund on each kind of order", () => {
  it("CRM-created and verified Shopify-originated prepaid orders can both be requested; an unverified Shopify one can not", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const svc = new RefundsService(runnerOf(tx));
      const a = await orderWith(tx, w.leadId, "CRM", crm());
      const b = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP({ metadata: RESOLVED }));
      const c = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP());
      assert.equal((await svc.createRequest(w.sales, a.orderId, { paymentId: a.paymentId, amount: "100", reason: "crm order" })).status, "PENDING");
      assert.equal((await svc.createRequest(w.sales, b.orderId, { paymentId: b.paymentId, amount: "100", reason: "shopify order" })).status, "PENDING");
      await rejects(svc.createRequest(w.sales, c.orderId, { paymentId: c.paymentId, amount: "100", reason: "unresolved" }), 400, /not been verified/);
    });
  });
});

describe("looking up the Cashfree references of a Shopify payment (fakes only)", () => {
  const receipt = (over: Partial<ShopifyReceipt> = {}): ShopifyReceipt => ({ gateway: "Cashfree", receiptPaymentId: "6443901832", authorizationCode: "ShOrder123", kind: "SALE", status: "SUCCESS", test: null, cashfreeTxnId: null, ...over });
  const cfPay = (over: Partial<CashfreeOrderPayment> = {}): CashfreeOrderPayment => ({ cfPaymentId: "6443901832", paymentStatus: "SUCCESS", paymentAmount: "500", bankReference: "B1", paymentGroup: "upi", paymentTime: null, ...over });
  function svc(tx: Db, r: ShopifyReceipt | null, pays: CashfreeOrderPayment[] | Error) {
    const calls = { shopify: [] as string[], cashfree: [] as string[] };
    const service = new CashfreeIdResolutionService(runnerOf(tx), {
      shopify: () => ({ getTransactionReceipt: async (id) => { calls.shopify.push(id); return r; } }),
      cashfreeConfig: () => SANDBOX,
      cashfree: () => ({ getOrderPayments: async (id) => { calls.cashfree.push(id); if (pays instanceof Error) throw pays; return pays; } }),
    });
    return { service, calls };
  }

  it("verified references are recorded and the payment becomes refundable (and nothing else changes)", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const o = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP());
      const before = await tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } });
      const { service, calls } = svc(tx, receipt(), [cfPay(), cfPay()]);
      const r = await service.resolve(w.sales, o.orderId, o.paymentId);
      assert.deepEqual([r.resolved, r.cashfreeOrderId, r.cfPaymentId], [true, "ShOrder123", "6443901832"]);
      assert.deepEqual([calls.shopify.length, calls.cashfree], [1, ["ShOrder123"]]);
      const after = await tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } });
      assert.deepEqual([after.status, after.amount.toString(), after.providerPaymentId, after.refundedAmount], [before.status, before.amount.toString(), "#AWL97845.1", null]);
      assert.deepEqual(((after.metadata as any).cashfree), { ...((after.metadata as any).cashfree), cashfreeOrderId: "ShOrder123", cfPaymentId: "6443901832", idSource: "shopify-receipt-verified" });
      assert.equal((await info(tx, o.orderId)).eligible, true);
      // a second lookup does not call anything again
      const again = svc(tx, receipt(), [cfPay()]);
      assert.equal((await again.service.resolve(w.sales, o.orderId, o.paymentId)).resolved, true);
      assert.deepEqual([again.calls.shopify.length, again.calls.cashfree.length], [0, 0]);
    });
  });

  it("anything that does not verify records NOTHING and leaves the payment not refundable", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const o = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP());
      for (const [r, pays] of [[receipt({ receiptPaymentId: "1" }), [cfPay()]], [receipt(), [cfPay({ paymentAmount: "499" })]], [receipt(), []], [null, [cfPay()]], [receipt({ gateway: "Phonepe" }), [cfPay()]]] as const) {
        const out = await svc(tx, r, [...pays]).service.resolve(w.sales, o.orderId, o.paymentId);
        assert.equal(out.resolved, false);
        assert.ok(out.reason);
      }
      const p = await tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } });
      assert.equal((p.metadata as any)?.cashfree, undefined);
      assert.equal((await info(tx, o.orderId)).eligible, false);
    });
  });

  it("Cashfree answering 'no such order' is an unresolved result, not an error; a network failure changes nothing and says so", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const o = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP());
      const { ProviderHttpError } = await import("../integrations/integrations.common.js");
      const notFound = await svc(tx, receipt(), new ProviderHttpError("CASHFREE", 404, "order not found", false)).service.resolve(w.sales, o.orderId, o.paymentId);
      assert.deepEqual([notFound.resolved, /no order/.test(notFound.reason!)], [false, true]);
      await rejects(svc(tx, receipt(), new ProviderHttpError("CASHFREE", null, "timeout", true)).service.resolve(w.sales, o.orderId, o.paymentId), 502);
      assert.equal(((await tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } })).metadata as any)?.cashfree, undefined);
    });
  });

  it("only payments that can be looked up are looked up; scope applies", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const cod = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP({ provider: "Cash on Delivery (COD)", method: PaymentMethod.COD }));
      const other = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP({ provider: "Phonepe" }));
      const mine = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP());
      const { service, calls } = svc(tx, receipt(), [cfPay()]);
      await rejects(service.resolve(w.sales, cod.orderId, cod.paymentId), 400, /cash-on-delivery/);
      await rejects(service.resolve(w.sales, other.orderId, other.paymentId), 400, /not collected through Cashfree/);
      await rejects(service.resolve(w.sales2, mine.orderId, mine.paymentId), 404);
      await rejects(service.resolve(w.sales, mine.orderId, other.paymentId), 400, /does not belong/);
      assert.deepEqual([calls.shopify.length, calls.cashfree.length], [0, 0]);
    });
  });
});

describe("executing a refund on a Shopify-originated prepaid order (fake Cashfree)", () => {
  const answer = (over: Partial<CashfreeRefund> = {}): CashfreeRefund => ({ cfRefundId: "CFR-7", refundId: "x", orderId: "ShOrder123", refundStatus: "PENDING", refundAmount: "500", refundCurrency: "INR", statusDescription: null, refundArn: null, processedAt: null, ...over });

  it("uses the VERIFIED Cashfree order id (not Shopify's ids); completion applies the accounting to the Shopify payment row", async () => {
    await inRollback(async (tx, runner) => {
      const w = await setup(tx);
      const o = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP({ metadata: RESOLVED }));
      const rs = new RefundsService(runner);
      const req = await rs.createRequest(w.sales, o.orderId, { paymentId: o.paymentId, amount: "500", reason: "Customer returned" });
      await rs.approve(w.manager, req.id);
      const creates: { orderId: string; body: { refund_amount: number; refund_id: string } }[] = [];
      let status = "PENDING";
      const api: RefundApi = {
        createRefund: async (orderId, body) => { creates.push({ orderId, body }); return answer({ refundId: body.refund_id }); },
        getRefund: async (_o, refundId) => answer({ refundId, refundStatus: status }),
      };
      const ex = new RefundExecutionService(runner, { config: () => SANDBOX, client: () => api, env: {}, shopifyRefundable: async () => ({ amount: "500.00", currency: "INR" }) });
      assert.equal((await ex.execute(w.admin, req.id)).request.executionStatus, "PROCESSING");
      assert.deepEqual([creates.length, creates[0]!.orderId, creates[0]!.body.refund_amount], [1, "ShOrder123", 500]);
      assert.equal(creates[0]!.orderId === "#AWL97845.1", false);
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } })).refundedAmount, null);
      status = "SUCCESS";
      assert.equal((await ex.refresh(w.admin, req.id)).executionStatus, "COMPLETED");
      const p = await tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } });
      assert.deepEqual([p.status, p.refundedAmount?.toString()], [PaymentStatus.REFUNDED, "500"]);
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: o.orderId } })).status, OrderStatus.CANCELLED);
      assert.ok(await tx.activity.findFirst({ where: { orderId: o.orderId, type: ActivityType.PAYMENT_REFUNDED } }));
    });
  });

  it("an unverified Shopify payment can not be executed even if a request somehow exists", async () => {
    await inRollback(async (tx, runner) => {
      const w = await setup(tx);
      const o = await orderWith(tx, w.leadId, "SHOPIFY", shopifyP({ metadata: RESOLVED }));
      const rs = new RefundsService(runner);
      const req = await rs.createRequest(w.sales, o.orderId, { paymentId: o.paymentId, amount: "100", reason: "x" });
      await rs.approve(w.manager, req.id);
      await tx.payment.update({ where: { id: o.paymentId }, data: { metadata: {} } }); // references lost
      let sent = 0;
      const api: RefundApi = { createRefund: async () => { sent++; return answer(); }, getRefund: async () => answer() };
      await rejects(new RefundExecutionService(runner, { config: () => SANDBOX, client: () => api, env: {}, shopifyRefundable: async () => ({ amount: "500.00", currency: "INR" }) }).execute(w.admin, req.id), 400, /not been verified/);
      assert.equal(sent, 0);
    });
  });
});

describe("a Shopify re-sync never wipes a refund the CRM executed", () => {
  const sid = () => `9${Array.from({ length: 11 }, () => randomInt(0, 10)).join("")}`;
  function node(id: string, extra: Record<string, unknown> = {}) {
    return {
      ...codOrderNode(),
      id: `gid://shopify/Order/${id}`,
      name: `#DB${id.slice(-7)}`,
      updatedAt: "2026-09-19T10:05:00Z",
      email: null,
      phone: `5${sid().slice(0, 9)}`,
      customer: null,
      shippingAddress: { ...(orderNode().shippingAddress as Record<string, unknown>), phone: null },
      lineItems: { pageInfo: { hasNextPage: false }, nodes: [rawLineItem({ id: `gid://shopify/LineItem/${id}1`, product: { id: `gid://shopify/Product/${sid()}` }, variant: { id: `gid://shopify/ProductVariant/${sid()}` } })] },
      transactions: [rawTransaction({ id: `gid://shopify/OrderTransaction/${id}1`, gateway: "Cashfree", status: "SUCCESS", kind: "SALE", amountSet: money("699.0"), paymentId: "#AWL1.1" })],
      ...extra,
    };
  }

  it("the CRM's confirmed refund survives a re-sync that does not know about it; a larger refund reported by Shopify wins", async () => {
    await inRollback(async (tx) => {
      const id = sid();
      const w = await setup(tx);
      await tx.order.create({ data: { orderNumber: `SHP-${id}`, leadId: w.leadId, source: OrderSource.SHOPIFY, status: OrderStatus.CONFIRMED, totalAmount: "699.00", externalSource: "SHOPIFY", externalId: id } });
      const first = await upsertOrder(tx, mapOrder(normalized(node(id))), { force: true });
      const payment = await tx.payment.findFirstOrThrow({ where: { orderId: first.orderId!, externalSource: "SHOPIFY" } });
      assert.equal(payment.status, PaymentStatus.SUCCESS);
      // the CRM executed and Cashfree confirmed a partial refund
      const refundedAt = new Date("2026-10-07T10:00:00Z");
      await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.PARTIALLY_REFUNDED, refundedAmount: "200.00", refundedAt } });
      await upsertOrder(tx, mapOrder(normalized(node(id, { updatedAt: "2026-10-08T10:05:00Z" }))), { force: true });
      const kept = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      assert.deepEqual([kept.status, kept.refundedAmount?.toString(), kept.refundedAt?.toISOString()], [PaymentStatus.PARTIALLY_REFUNDED, "200", refundedAt.toISOString()]);
      // Shopify later reports a full refund: that is the larger figure and wins
      const sale = `gid://shopify/OrderTransaction/${id}1`;
      await upsertOrder(tx, mapOrder(normalized(node(id, { updatedAt: "2026-10-09T10:05:00Z", transactions: [rawTransaction({ id: sale, gateway: "Cashfree", status: "SUCCESS", kind: "SALE", amountSet: money("699.0"), paymentId: "#AWL1.1" }), rawTransaction({ id: `gid://shopify/OrderTransaction/${id}2`, kind: "REFUND", status: "SUCCESS", gateway: "Cashfree", amountSet: money("699.0"), parentTransaction: { id: sale } })] }))), { force: true });
      const after = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      assert.deepEqual([after.status, after.refundedAmount?.toString()], [PaymentStatus.REFUNDED, "699"]);
    });
  });

  it("with no CRM refund, Shopify stays the source of truth (unchanged behaviour)", async () => {
    await inRollback(async (tx) => {
      const id = sid();
      const w = await setup(tx);
      await tx.order.create({ data: { orderNumber: `SHP-${id}`, leadId: w.leadId, source: OrderSource.SHOPIFY, status: OrderStatus.CONFIRMED, totalAmount: "699.00", externalSource: "SHOPIFY", externalId: id } });
      const first = await upsertOrder(tx, mapOrder(normalized(node(id))), { force: true });
      await upsertOrder(tx, mapOrder(normalized(node(id, { updatedAt: "2026-10-08T10:05:00Z" }))), { force: true });
      const p = await tx.payment.findFirstOrThrow({ where: { orderId: first.orderId!, externalSource: "SHOPIFY" } });
      assert.deepEqual([p.status, p.refundedAmount], [PaymentStatus.SUCCESS, null]);
    });
  });
});

describe("#AWL101729-shaped Shopify payment (Shopify + Fastrr, Cashfree, ₹820): the Cashfree lookup asks for the RIGHT references only (fakes only)", () => {
  const TX = "20808276639933"; // Shopify's transaction id - what the CRM stores as the payment reference
  const SHOPIFY_PAYMENT_ID = "#AWL101729.1";
  const ORDER_REF = "Shrjluie1791354887963"; // the receipt's authorization code: Cashfree's order id, to be verified
  const CF_PAY = "6681442035"; // receiptJson.payment_id (== the order's Cashfree_txn_id attribute)
  const PRODUCTION = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "production", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret-not-real" });

  const receipt = (over: Partial<ShopifyReceipt> = {}): ShopifyReceipt => ({ gateway: "Cashfree", receiptPaymentId: CF_PAY, authorizationCode: ORDER_REF, kind: "SALE", status: "SUCCESS", test: false, cashfreeTxnId: CF_PAY, ...over });
  const cfPay = (over: Partial<CashfreeOrderPayment> = {}): CashfreeOrderPayment => ({ cfPaymentId: CF_PAY, paymentStatus: "SUCCESS", paymentAmount: "820", bankReference: "B1", paymentGroup: "upi", paymentTime: null, ...over });
  const awlPayment = () => shopifyP({ amount: "820.00", externalId: TX, providerPaymentId: SHOPIFY_PAYMENT_ID, transactionReference: TX });

  /** Cashfree fake that records every order id it is asked about and only knows `known` orders (others: 404, like the real API). */
  async function run(tx: Db, w: Awaited<ReturnType<typeof setup>>, p: { orderId: string; paymentId: string }, opts: { receipt?: ShopifyReceipt | null; config?: CashfreeConfig; known?: Record<string, CashfreeOrderPayment[]> }) {
    const { ProviderHttpError } = await import("../integrations/integrations.common.js");
    const asked = { shopify: [] as string[], cashfree: [] as string[] };
    const service = new CashfreeIdResolutionService(runnerOf(tx), {
      shopify: () => ({ getTransactionReceipt: async (id) => { asked.shopify.push(id); return opts.receipt === undefined ? receipt() : opts.receipt; } }),
      cashfreeConfig: () => opts.config ?? PRODUCTION,
      cashfree: () => ({ getOrderPayments: async (id) => { asked.cashfree.push(id); const hit = (opts.known ?? { [ORDER_REF]: [cfPay()] })[id]; if (!hit) throw new ProviderHttpError("CASHFREE", 404, "order_not_found", false); return hit; } }),
    });
    const result = await service.resolve(w.sales, p.orderId, p.paymentId);
    return { result, asked, row: await tx.payment.findUniqueOrThrow({ where: { id: p.paymentId } }) };
  }

  it("verified: Cashfree is asked ONLY for the receipt's order reference; Shopify's ids are never sent to Cashfree or stored as Cashfree ids; Refund becomes available", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const o = await orderWith(tx, w.leadId, "SHOPIFY", awlPayment());
      const before = (await info(tx, o.orderId));
      assert.deepEqual([before.eligible, before.canResolve], [false, true], "not refundable until verified");

      const { result, asked, row } = await run(tx, w, o, {});
      assert.deepEqual(asked.shopify, [TX], "Shopify is read by its own transaction id, only to fetch the receipt");
      assert.deepEqual(asked.cashfree, [ORDER_REF], "Cashfree is asked for the authorization code as the ORDER id - never the Shopify transaction id");
      for (const never of [TX, SHOPIFY_PAYMENT_ID, CF_PAY]) assert.equal(asked.cashfree.includes(never), false, `${never} is not a Cashfree order id`);
      assert.deepEqual([result.resolved, result.cashfreeOrderId, result.cfPaymentId], [true, ORDER_REF, CF_PAY]);
      const saved = (row.metadata as any).cashfree;
      assert.deepEqual([saved.cashfreeOrderId, saved.cfPaymentId], [ORDER_REF, CF_PAY]);
      assert.equal(JSON.stringify(row.metadata).includes(TX), false, "the Shopify transaction id is not recorded as a Cashfree identifier");
      assert.equal(JSON.stringify(row.metadata).includes(SHOPIFY_PAYMENT_ID), false);
      assert.deepEqual([row.providerPaymentId, row.transactionReference], [SHOPIFY_PAYMENT_ID, TX], "Shopify's own references stay as they were");
      const after = await info(tx, o.orderId);
      assert.deepEqual([after.eligible, after.refundableAmount], [true, "820.00"]);
      // and the existing workflow takes over - requesting moves no money
      const req = await new RefundsService(runnerOf(tx)).createRequest(w.sales, o.orderId, { paymentId: o.paymentId, amount: "820", reason: "Customer returned the order" });
      assert.equal(req.status, "PENDING");
    });
  });

  it("an environment mismatch is refused BEFORE Cashfree is contacted: a live Shopify payment is never looked up in the sandbox (and a test one never in production)", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const o = await orderWith(tx, w.leadId, "SHOPIFY", awlPayment());
      const live = await run(tx, w, o, { config: SANDBOX });
      assert.equal(live.result.resolved, false);
      assert.match(live.result.reason!, /live payment, but the CRM is connected to the Cashfree sandbox/);
      assert.equal(live.asked.cashfree.length, 0);
      assert.equal((live.row.metadata as any)?.cashfree, undefined);
      assert.equal((live.row.metadata as any).cashfreeVerification.status, "FAILED");
      assert.match((await info(tx, o.orderId)).ineligibleReason!, /^Cashfree verification failed: This is a live payment/);
      const test = await run(tx, w, o, { receipt: receipt({ test: true }), config: PRODUCTION });
      assert.match(test.result.reason!, /test payment, but the CRM is connected to live Cashfree/);
      assert.equal(test.asked.cashfree.length, 0);
      assert.equal((test.row.metadata as any)?.cashfree, undefined);
      assert.equal((await info(tx, o.orderId)).eligible, false);
    });
  });

  it("Cashfree not knowing the reference leaves it unresolved with an actionable reason; a fake that only knows the Shopify transaction id is never asked for it", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const o = await orderWith(tx, w.leadId, "SHOPIFY", awlPayment());
      // The (wrong) world where Cashfree knows an order called after Shopify's transaction id / payment id: the resolver must not go looking there.
      const wrongWorld = { [TX]: [cfPay()], [SHOPIFY_PAYMENT_ID]: [cfPay()], [CF_PAY]: [cfPay()] };
      const r = await run(tx, w, o, { known: wrongWorld });
      assert.equal(r.result.resolved, false);
      assert.deepEqual(r.asked.cashfree, [ORDER_REF]);
      assert.match(r.result.reason!, /Cashfree \(production\) has no order with the reference from Shopify \(Shrjluie1791354887963\)/);
      assert.equal((r.row.metadata as any)?.cashfree, undefined);
      assert.equal((await info(tx, o.orderId)).eligible, false);
    });
  });

  it("anything ambiguous or inconsistent records NOTHING: no receipt, other gateway, mismatching ids, wrong amount, several payments, failed payment", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const o = await orderWith(tx, w.leadId, "SHOPIFY", awlPayment());
      const cases: Array<[string, Parameters<typeof run>[3]]> = [
        ["no receipt", { receipt: null }],
        ["other gateway", { receipt: receipt({ gateway: "Phonepe" }) }],
        ["no authorization code", { receipt: receipt({ authorizationCode: null }) }],
        ["no payment id in the receipt", { receipt: receipt({ receiptPaymentId: null }) }],
        ["Shopify records disagree", { receipt: receipt({ cashfreeTxnId: "1234567890" }) }],
        ["different successful payment at Cashfree", { known: { [ORDER_REF]: [cfPay({ cfPaymentId: "7777777777" })] } }],
        ["wrong amount", { known: { [ORDER_REF]: [cfPay({ paymentAmount: "819" })] } }],
        ["two successful payments", { known: { [ORDER_REF]: [cfPay(), cfPay({ cfPaymentId: "8888888888" })] } }],
        ["failed payment", { known: { [ORDER_REF]: [cfPay({ paymentStatus: "FAILED" })] } }],
      ];
      for (const [label, opts] of cases) {
        const r = await run(tx, w, o, opts);
        assert.equal(r.result.resolved, false, label);
        assert.equal((r.row.metadata as any)?.cashfree, undefined, `${label}: no Cashfree id saved`);
        assert.equal((r.row.metadata as any)?.cashfreeVerification?.status, "FAILED", `${label}: the failure is recorded`);
      }
      assert.deepEqual([(await info(tx, o.orderId)).eligible, (await info(tx, o.orderId)).canResolve], [false, true]);
    });
  });

  it("COD, failed/unpaid and non-Cashfree Shopify payments of the same shape are not looked up at all", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const cod = await orderWith(tx, w.leadId, "SHOPIFY", { ...awlPayment(), externalId: `${TX}1`, provider: "Cash on Delivery (COD)", method: PaymentMethod.COD });
      const failed = await orderWith(tx, w.leadId, "SHOPIFY", { ...awlPayment(), externalId: `${TX}2`, status: PaymentStatus.FAILED, paidAt: null });
      const other = await orderWith(tx, w.leadId, "SHOPIFY", { ...awlPayment(), externalId: `${TX}3`, provider: "Phonepe" });
      for (const o of [cod, failed, other]) {
        const service = new CashfreeIdResolutionService(runnerOf(tx), { shopify: () => { throw new Error("must not be called"); }, cashfreeConfig: () => PRODUCTION, cashfree: () => { throw new Error("must not be called"); } });
        await rejects(service.resolve(w.sales, o.orderId, o.paymentId), 400);
        assert.equal((await info(tx, o.orderId)).eligible, false);
      }
    });
  });
});
