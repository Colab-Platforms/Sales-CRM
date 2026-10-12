// Shopify -> CRM -> refund, end to end with NO manual step: a Shopify prepaid Cashfree order is synced, its Cashfree payment is verified automatically, Shopify's
// own refundable amount caps every refund, and the existing request / approval / execution workflow takes over. Real schema, one rolled-back transaction per test;
// the real handler, live service, syncOrderById, upsertOrder and post-sync verifier run - ONLY Shopify and Cashfree are faked. No refund can reach a real provider.
// Run with: npm run test:db.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "@/middlewares/auth.js";
import { prisma } from "../../lib/prisma.js";
import { PaymentStatus, RefundExecutionStatus, RefundRequestStatus, Role } from "../../../generated/prisma/enums.js";
import type { Db, TxRunner } from "../integrations/integrations.common.js";
import { ProviderHttpError } from "../integrations/integrations.common.js";
import { loadCashfreeConfig, type CashfreeConfig } from "../cashfree/cashfree.config.js";
import type { CashfreeOrderPayment, CashfreeRefund } from "../cashfree/cashfree.client.js";
import { codOrderNode, money, orderNode, rawTransaction } from "../shopify/shopify.fixtures.js";
import { syncOrderById } from "../shopify/shopify.sync.js";
import OrdersLiveService from "../orders/orders.live.service.js";
import { makeSyncLiveOrder } from "../orders/orders.live.controller.js";
import RefundsService, { loadOrderRefundInfo } from "./refunds.service.js";
import RefundExecutionService, { type RefundApi } from "./refunds.execution.js";
import { createCashfreeAutoVerifyHook, refreshShopifyRefundable } from "./refunds.autoverify.js";
import CashfreeIdResolutionService, { ShopifyReceiptReader } from "./refunds.resolve.js";

class Rollback extends Error {}
after(() => prisma.$disconnect());
const uid = () => randomUUID();
const digits = (n: number) => Array.from({ length: n }, () => randomInt(0, 10)).join("");
const runnerOf = (tx: Db): TxRunner => ({ $transaction: (cb) => cb(tx) });
async function inRollback(fn: (tx: Db) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
const rejects = (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => { assert.equal(e.statusCode, status, e.message); if (re) assert.match(e.message, re); return true; });

const PRODUCTION = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "production", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret-not-real" });
const SANDBOX = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret-not-real" });

// ---- the shape of the real order #AWL101729 (Shopify + Fastrr checkout, paid through Cashfree). 584.10 is only this fixture's figure for "what Shopify says is
// refundable"; no production code contains it. ----
const TX = "20808276639933"; // Shopify's transaction id (the CRM's payment reference) - NOT a Cashfree id
const ORDER_REF = "Shrjluie1791354887963"; // receipt authorization code = Cashfree order id
const CF_PAY = "6681442035"; // receipt payment_id = order attribute Cashfree_txn_id = Cashfree payment id
const SHOPIFY_REFUNDABLE = "584.10";

type U = { id: string; username: string; role: Role };
async function actors(tx: Db) {
  const mk = (name: string, role: Role) => tx.user.create({ data: { name, username: `${name.toLowerCase()}-${uid()}`, role }, select: { id: true, username: true } }).then((u) => ({ id: u.id, username: u.username, role }) as U);
  const [sales, manager, admin] = await Promise.all([mk("Tele", Role.SALESPERSON), mk("Mgr", Role.MANAGER), mk("Admin", Role.ADMIN)]);
  const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: manager.id }, select: { id: true } });
  await tx.groupMember.create({ data: { groupId: group.id, userId: sales.id, joinedAt: new Date(), isActive: true } });
  return { sales, manager, admin, groupId: group.id };
}
type Actors = Awaited<ReturnType<typeof actors>>;

/** What the fake Shopify and Cashfree say, plus a record of everything they were asked. */
interface World {
  refundable: string | null; // Shopify's suggestedRefund maximum; null = Shopify does not say
  refundableCurrency: string;
  receipt: boolean; // does the transaction have a receipt at Shopify
  test: boolean;
  txnAttribute: string | null;
  config: CashfreeConfig;
  cashfree: Record<string, CashfreeOrderPayment[]>; // by Cashfree order id; unknown ids answer 404 like the real API
  calls: { orderQueries: string[]; receipts: string[]; refundables: string[]; cashfree: string[] };
}
const cfPay = (over: Partial<CashfreeOrderPayment> = {}): CashfreeOrderPayment => ({ cfPaymentId: CF_PAY, paymentStatus: "SUCCESS", paymentAmount: "820", bankReference: "B1", paymentGroup: "upi", paymentTime: null, ...over });
const world = (over: Partial<World> = {}): World => ({ refundable: SHOPIFY_REFUNDABLE, refundableCurrency: "INR", receipt: true, test: false, txnAttribute: CF_PAY, config: PRODUCTION, cashfree: { [ORDER_REF]: [cfPay()] }, calls: { orderQueries: [], receipts: [], refundables: [], cashfree: [] }, ...over });

function fakeShopify(w: World, order: Record<string, unknown>) {
  return {
    query: async (doc: string, vars: { id?: string } = {}) => {
      if (/suggestedRefund/.test(doc)) {
        w.calls.refundables.push(String(vars.id));
        return { order: { suggestedRefund: w.refundable === null ? null : { maximumRefundableSet: { shopMoney: { amount: w.refundable, currencyCode: w.refundableCurrency } } } } };
      }
      if (/on OrderTransaction/.test(doc)) {
        w.calls.receipts.push(String(vars.id));
        if (!w.receipt) return { node: null };
        return { node: { kind: "SALE", status: "SUCCESS", gateway: "Cashfree", authorizationCode: ORDER_REF, test: w.test, receiptJson: JSON.stringify({ payment_id: CF_PAY }), order: { customAttributes: w.txnAttribute ? [{ key: "GATEWAY", value: "CUSTOM Fastrr" }, { key: "Cashfree_txn_id", value: w.txnAttribute }] : [] } } };
      }
      w.calls.orderQueries.push(String(vars.id));
      return { order };
    },
  };
}
const fakeCashfree = (w: World) => ({
  getOrderPayments: async (id: string) => {
    w.calls.cashfree.push(id);
    const hit = w.cashfree[id];
    if (!hit) throw new ProviderHttpError("CASHFREE", 404, "order_not_found", false);
    return hit;
  },
});

/** A Shopify order shaped like #AWL101729: ₹820, Cashfree, transaction TX. Lines carry no product ids so only the one order query has to be answered. */
function awlNode(over: Record<string, unknown> = {}, tx: Record<string, unknown> = {}) {
  const id = String(over.externalId ?? `9${digits(12)}`);
  const txId = String(over.txId ?? `2${digits(13)}`); // Shopify payment ids are unique per payment
  const { externalId: _drop, txId: _drop2, ...rest } = over;
  return orderNode({
    id: `gid://shopify/Order/${id}`,
    name: `#AWL${digits(6)}`,
    subtotalPriceSet: money("820.0"),
    totalPriceSet: money("820.0"),
    customer: { id: `gid://shopify/Customer/8${digits(12)}`, firstName: "Meera", lastName: "Nair", email: `meera-${uid().slice(0, 8)}@example.invalid`, phone: `+91 9${digits(9)}` },
    email: null,
    cancelledAt: "2026-10-07T06:40:00Z", // a refund follows a cancellation: Shopify reports the order as cancelled
    cancelReason: "CUSTOMER",
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: `gid://shopify/LineItem/${id}1`, title: "Herbal Masala", variantTitle: "120 pouches", sku: "SKU-AWL-120", quantity: 1, originalUnitPriceSet: money("820.0"), discountAllocations: [], taxLines: [], product: null, variant: null }] },
    transactions: [rawTransaction({ id: `gid://shopify/OrderTransaction/${txId}`, gateway: "Cashfree", status: "SUCCESS", kind: "SALE", amountSet: money("820.0"), paymentId: null, ...tx })],
    ...rest,
  });
}
const shopifyIdOf = (node: Record<string, unknown>) => String(node.id).split("/").pop()!;

/** The admin presses "Sync order to CRM": real handler -> real live service -> real syncOrderById/upsert -> real post-sync verifier (fake Shopify/Cashfree). */
async function post(tx: Db, w: World, node: Record<string, unknown>, user: U, hook?: () => Promise<void>) {
  const service = new OrdersLiveService(prisma, () => fakeShopify(w, node) as never, runnerOf(tx), syncOrderById, (client, runner) =>
    hook ? async () => hook() : createCashfreeAutoVerifyHook(client, runner, { cashfreeConfig: () => w.config, cashfree: () => fakeCashfree(w) }),
  );
  const out: { status?: number; body?: any } = {};
  const res = { status: (s: number) => ({ json: (b: unknown) => { out.status = s; out.body = b; } }) } as unknown as Response;
  await makeSyncLiveOrder(service)({ params: { externalId: shopifyIdOf(node) }, user } as unknown as AuthRequest, res);
  return out;
}

/** Syncs a (new) order and puts its customer under the telecaller, like lead assignment would. Returns the CRM order and its only payment. */
async function synced(tx: Db, a: Actors, w: World, node = awlNode()) {
  const r = await post(tx, w, node, a.admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const orderId: string = r.body.data.orderId;
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { leadId: true } });
  await tx.lead.update({ where: { id: order.leadId }, data: { ownerId: a.sales.id, groupId: a.groupId } });
  const payment = await tx.payment.findFirstOrThrow({ where: { orderId } });
  return { orderId, paymentId: payment.id, externalId: shopifyIdOf(node), node };
}
const view = async (tx: Db, orderId: string) => (await loadOrderRefundInfo(tx, orderId)).payments[0]!;
const meta = async (tx: Db, paymentId: string) => (await tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).metadata as any;

describe("#AWL101729: Sync order to CRM -> automatic Cashfree verification -> Refund (no manual lookup)", () => {
  it("syncs the order, verifies Cashfree by itself and stores ONLY verified ids; Shopify's own ids are never sent to Cashfree", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const w = world();
      const s = await synced(tx, a, w, awlNode({ name: "#AWL101729", txId: TX }));

      // Shopify was read (read-only) by exact ids; Cashfree was asked for exactly the receipt's authorization code - not the Shopify transaction id
      assert.deepEqual(w.calls.receipts, [`gid://shopify/OrderTransaction/${TX}`]);
      assert.deepEqual(w.calls.refundables, [`gid://shopify/Order/${s.externalId}`]);
      assert.deepEqual(w.calls.cashfree, [ORDER_REF]);
      for (const never of [TX, "#AWL101729", "#AWL101729.1", CF_PAY, s.externalId]) assert.equal(w.calls.cashfree.includes(never), false, `${never} is not a Cashfree order id`);

      const m = await meta(tx, s.paymentId);
      assert.deepEqual([m.cashfree.cashfreeOrderId, m.cashfree.cfPaymentId, m.cashfreeVerification.status], [ORDER_REF, CF_PAY, "VERIFIED"]);
      assert.equal(JSON.stringify(m).includes(TX), false, "the Shopify transaction id is not recorded as a Cashfree identifier");
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: s.paymentId } });
      assert.deepEqual([payment.transactionReference, payment.amount.toString(), payment.provider, payment.status], [TX, "820", "Cashfree", PaymentStatus.SUCCESS]);
      assert.equal(((await tx.order.findUniqueOrThrow({ where: { id: s.orderId } })).metadata as any).shopifyRefundable.amount, SHOPIFY_REFUNDABLE);
      assert.equal(await tx.refundRequest.count({ where: { orderId: s.orderId } }), 0, "nothing is refunded or requested by the sync");

      // The order is refundable straight away: no "Look up Cashfree details" step is needed (canResolve is false, there is nothing left to resolve)
      const v = await view(tx, s.orderId);
      assert.deepEqual([v.eligible, v.canResolve, v.ineligibleReason], [true, false, null]);
      assert.deepEqual([v.amount, v.refundableAmount, v.shopifyRefundableAmount, v.limitedByShopify], ["820.00", SHOPIFY_REFUNDABLE, SHOPIFY_REFUNDABLE, true]);
    });
  });

  it("the most that can be requested is Shopify's refundable amount: 100 and 584.10 allowed; 584.11, 600 and the original 820 refused", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const rs = new RefundsService(runnerOf(tx));
      const cap = /Only ₹584\.10 can be refunded: Shopify reports ₹584\.10 refundable on this order/;
      for (const [amount, ok] of [["100", true], ["584.10", true], ["584.11", false], ["600", false], ["820", false]] as const) {
        const s = await synced(tx, a, world()); // a fresh order each time, so earlier requests do not hold any of the amount
        const attempt = rs.createRequest(a.sales, s.orderId, { paymentId: s.paymentId, amount, reason: "Customer returned the product" });
        if (ok) assert.equal((await attempt).status, RefundRequestStatus.PENDING, amount);
        else await rejects(attempt, 400, cap);
      }
    });
  });

  it("open requests count against Shopify's amount too, and roles work as before: telecaller requests, manager approves, admin can also request", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const rs = new RefundsService(runnerOf(tx));
      const s = await synced(tx, a, world());
      const first = await rs.createRequest(a.sales, s.orderId, { paymentId: s.paymentId, amount: "300", reason: "first" });
      assert.equal((await rs.approve(a.manager, first.id)).status, RefundRequestStatus.APPROVED);
      const v = await view(tx, s.orderId);
      assert.deepEqual([v.refundableAmount, v.reservedAmount], ["284.10", "300.00"]);
      await rejects(rs.createRequest(a.sales, s.orderId, { paymentId: s.paymentId, amount: "284.11", reason: "too much" }), 400, /Only ₹284\.10 can be refunded: Shopify reports ₹584\.10/);
      assert.equal((await rs.createRequest(a.admin, s.orderId, { paymentId: s.paymentId, amount: "284.10", reason: "the rest" })).status, RefundRequestStatus.PENDING);
      await rejects(rs.approve(a.sales, first.id), 403);
    });
  });

  it("follows Shopify as it changes: ₹300 -> max 300; ₹0 -> not refundable; a Shopify-side refund of ₹235.90 is respected; fully refunded -> nothing to refund", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const rs = new RefundsService(runnerOf(tx));
      const w = world();
      const node = awlNode();
      const s = await synced(tx, a, w, node);
      assert.equal((await view(tx, s.orderId)).refundableAmount, SHOPIFY_REFUNDABLE);

      // each later sync (a webhook, the catch-up or the button again) re-reads Shopify; Cashfree is not asked again for an already verified payment
      w.refundable = "300.00";
      assert.equal((await post(tx, w, node, a.admin)).status, 200);
      assert.deepEqual(w.calls.cashfree, [ORDER_REF], "already verified: not looked up again");
      let v = await view(tx, s.orderId);
      assert.deepEqual([v.eligible, v.refundableAmount, v.limitedByShopify], [true, "300.00", true]);
      await rejects(rs.createRequest(a.sales, s.orderId, { paymentId: s.paymentId, amount: "300.01", reason: "x" }), 400, /Only ₹300\.00 can be refunded/);

      w.refundable = "0.00";
      await post(tx, w, node, a.admin);
      v = await view(tx, s.orderId);
      assert.deepEqual([v.eligible, v.refundableAmount, v.ineligibleReason], [false, "0.00", "Shopify reports nothing left to refund on this order."]);
      await rejects(rs.createRequest(a.sales, s.orderId, { paymentId: s.paymentId, amount: "1", reason: "x" }), 400, /Shopify reports nothing left to refund/);

      // Shopify refunded 235.90 outside the CRM: the CRM sees the payment as partly refunded and Shopify still has 584.10 available
      w.refundable = SHOPIFY_REFUNDABLE;
      const sale = String((node.transactions as any[])[0].id);
      const saleTx = sale.split("/").pop()!;
      const refunded = awlNode({ externalId: s.externalId, txId: saleTx, displayFinancialStatus: "PARTIALLY_REFUNDED", totalRefundedSet: money("235.9"), updatedAt: "2026-10-09T10:00:00Z" });
      (refunded.transactions as any[]).push(rawTransaction({ id: "gid://shopify/OrderTransaction/30000000000001", kind: "REFUND", status: "SUCCESS", gateway: "Cashfree", amountSet: money("235.9"), parentTransaction: { id: sale } }));
      refunded.customer = node.customer;
      await post(tx, w, refunded, a.admin);
      v = await view(tx, s.orderId);
      assert.deepEqual([v.status, v.refundedAmount, v.refundableAmount, v.eligible], [PaymentStatus.PARTIALLY_REFUNDED, "235.90", "584.10", true]);
      await rejects(rs.createRequest(a.sales, s.orderId, { paymentId: s.paymentId, amount: "584.11", reason: "x" }), 400);

      // ... and later fully refunded
      const full = awlNode({ externalId: s.externalId, txId: saleTx, displayFinancialStatus: "REFUNDED", totalRefundedSet: money("820.0"), updatedAt: "2026-10-10T10:00:00Z" });
      (full.transactions as any[]).push(rawTransaction({ id: "gid://shopify/OrderTransaction/30000000000002", kind: "REFUND", status: "SUCCESS", gateway: "Cashfree", amountSet: money("820.0"), parentTransaction: { id: sale } }));
      full.customer = node.customer;
      w.refundable = "0.00";
      await post(tx, w, full, a.admin);
      v = await view(tx, s.orderId);
      assert.deepEqual([v.status, v.eligible], [PaymentStatus.REFUNDED, false]);
      assert.match(v.ineligibleReason!, /already been fully refunded/);
    });
  });

  it("syncing again never duplicates anything and never re-asks Cashfree; a failing post-sync step does not fail the sync", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const w = world();
      const node = awlNode();
      const s = await synced(tx, a, w, node);
      for (let i = 0; i < 3; i++) assert.equal((await post(tx, w, node, a.admin)).status, 200);
      assert.equal(await tx.order.count({ where: { externalSource: "SHOPIFY", externalId: s.externalId } }), 1);
      assert.equal(await tx.payment.count({ where: { orderId: s.orderId } }), 1);
      assert.deepEqual(w.calls.cashfree, [ORDER_REF]);

      const broken = awlNode();
      const ok = await post(tx, w, broken, a.admin, async () => { throw new Error("post-sync exploded"); });
      assert.equal(ok.status, 200, "the order is synced even though the verification step failed");
      assert.equal(await tx.order.count({ where: { externalSource: "SHOPIFY", externalId: shopifyIdOf(broken) } }), 1);
    });
  });
});

describe("what is NOT refundable after the automatic verification", () => {
  const scenarios: Array<{ name: string; world?: Partial<World>; node?: () => Record<string, unknown>; reason: RegExp; verified?: boolean; noCashfreeCall?: boolean; noShopifyReads?: boolean }> = [
    { name: "COD", node: () => codOrderNode({ id: `gid://shopify/Order/9${digits(12)}`, name: "#AWL1", customer: { id: `gid://shopify/Customer/8${digits(12)}`, firstName: "R", lastName: "K", email: `r-${uid().slice(0, 8)}@example.invalid`, phone: `+91 9${digits(9)}` }, lineItems: awlNode().lineItems }), reason: /cash-on-delivery/, noCashfreeCall: true, noShopifyReads: true },
    { name: "failed payment", node: () => awlNode({}, { status: "FAILURE" }), reason: /Only a successful payment/, noCashfreeCall: true, noShopifyReads: true },
    { name: "unpaid payment", node: () => awlNode({ displayFinancialStatus: "PENDING" }, { status: "PENDING" }), reason: /Only a successful payment/, noCashfreeCall: true, noShopifyReads: true },
    { name: "non-Cashfree gateway", node: () => awlNode({ paymentGatewayNames: ["Phonepe"] }, { gateway: "Phonepe" }), reason: /not collected through Cashfree/, noCashfreeCall: true, noShopifyReads: true },
    { name: "Shopify has no receipt for the transaction (no Cashfree ids)", world: { receipt: false }, reason: /^Cashfree verification failed: Shopify has no record/, noCashfreeCall: true },
    { name: "wrong Cashfree payment id", world: { cashfree: { [ORDER_REF]: [cfPay({ cfPaymentId: "1111111111" })] } }, reason: /does not match the one in the Shopify receipt/ },
    { name: "wrong amount at Cashfree", world: { cashfree: { [ORDER_REF]: [cfPay({ paymentAmount: "819" })] } }, reason: /amount does not match/ },
    { name: "ambiguous Cashfree payment (two different successful payments)", world: { cashfree: { [ORDER_REF]: [cfPay(), cfPay({ cfPaymentId: "2222222222" })] } }, reason: /several different successful payments/ },
    { name: "the Cashfree payment is not successful", world: { cashfree: { [ORDER_REF]: [cfPay({ paymentStatus: "FAILED" })] } }, reason: /no successful payment/ },
    { name: "Cashfree does not know the order", world: { cashfree: {} }, reason: /Cashfree \(production\) has no order with the reference from Shopify \(Shrjluie1791354887963\)/ },
    { name: "Shopify's own records disagree about the payment id", world: { txnAttribute: "9999999999" }, reason: /Shopify's own records disagree/ },
    { name: "live payment but the CRM is connected to the Cashfree sandbox", world: { config: SANDBOX }, reason: /live payment, but the CRM is connected to the Cashfree sandbox/, noCashfreeCall: true },
    { name: "test payment but the CRM is connected to live Cashfree", world: { test: true }, reason: /test payment, but the CRM is connected to live Cashfree/, noCashfreeCall: true },
  ];
  for (const sc of scenarios) {
    it(`${sc.name}: no executable Refund, no Cashfree ids saved, the reason is explained`, async () => {
      await inRollback(async (tx) => {
        const a = await actors(tx);
        const w = world(sc.world);
        const s = await synced(tx, a, w, sc.node ? sc.node() : awlNode());
        const v = await view(tx, s.orderId);
        assert.equal(v.eligible, false);
        assert.match(v.ineligibleReason!, sc.reason);
        assert.equal((await meta(tx, s.paymentId))?.cashfree, undefined, "no Cashfree identifier saved without an exact verified match");
        if (sc.noCashfreeCall) assert.equal(w.calls.cashfree.length, 0, "Cashfree is not contacted");
        if (sc.noShopifyReads) assert.deepEqual([w.calls.receipts.length, w.calls.refundables.length], [0, 0], "nothing to verify, nothing read");
        await rejects(new RefundsService(runnerOf(tx)).createRequest(a.sales, s.orderId, { paymentId: s.paymentId, amount: "10", reason: "x" }), 400);
      });
    });
  }

  it("verified Cashfree but Shopify's refundable amount unknown (or in another currency): still not refundable - an unknown limit is never 'no limit'", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const unknown = await synced(tx, a, world({ refundable: null }));
      assert.equal((await meta(tx, unknown.paymentId)).cashfreeVerification.status, "VERIFIED");
      let v = await view(tx, unknown.orderId);
      assert.deepEqual([v.eligible, v.canResolve], [false, true]);
      assert.match(v.ineligibleReason!, /refundable amount for this order has not been confirmed yet/);
      const usd = await synced(tx, a, world({ refundableCurrency: "USD" }));
      v = await view(tx, usd.orderId);
      assert.equal(v.eligible, false);
      assert.match(v.ineligibleReason!, /different currency/);
      for (const s of [unknown, usd]) await rejects(new RefundsService(runnerOf(tx)).createRequest(a.sales, s.orderId, { paymentId: s.paymentId, amount: "10", reason: "x" }), 400);
    });
  });
});

describe("executing a Shopify-originated refund re-checks Shopify live (fake Cashfree, sandbox guard unchanged)", () => {
  const answer = (over: Partial<CashfreeRefund> = {}): CashfreeRefund => ({ cfRefundId: "CFR-9", refundId: "x", orderId: ORDER_REF, refundStatus: "PENDING", refundAmount: "584.1", refundCurrency: "INR", statusDescription: null, refundArn: null, processedAt: null, ...over });
  async function approvedRequest(tx: Db, a: Actors, amount: string) {
    const s = await synced(tx, a, world());
    const rs = new RefundsService(runnerOf(tx));
    const req = await rs.createRequest(a.sales, s.orderId, { paymentId: s.paymentId, amount, reason: "Customer returned the product" });
    await rs.approve(a.manager, req.id);
    return { s, req };
  }
  const exec = (tx: Db, api: RefundApi, live: () => Promise<{ amount: string; currency: string } | null>) => new RefundExecutionService(runnerOf(tx), { config: () => SANDBOX, client: () => api, env: {}, shopifyRefundable: live });

  it("sends the refund only when Shopify still has room: to the VERIFIED Cashfree order id, for the requested amount", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const { req } = await approvedRequest(tx, a, SHOPIFY_REFUNDABLE);
      const sent: Array<{ orderId: string; amount: number }> = [];
      const api: RefundApi = { createRefund: async (orderId, body) => { sent.push({ orderId, amount: body.refund_amount }); return answer({ refundId: body.refund_id }); }, getRefund: async (_o, refundId) => answer({ refundId }) };
      const r = await exec(tx, api, async () => ({ amount: SHOPIFY_REFUNDABLE, currency: "INR" })).execute(a.admin, req.id);
      assert.deepEqual([r.sentToProvider, r.request.executionStatus], [true, RefundExecutionStatus.PROCESSING]);
      assert.deepEqual(sent, [{ orderId: ORDER_REF, amount: 584.1 }]);
    });
  });

  it("Shopify now reports less (a refund made in Shopify's admin), reports nothing, or can not be asked: NOTHING is sent to Cashfree", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const { req } = await approvedRequest(tx, a, SHOPIFY_REFUNDABLE);
      let sent = 0;
      const api: RefundApi = { createRefund: async () => { sent++; return answer(); }, getRefund: async () => answer() };
      await rejects(exec(tx, api, async () => ({ amount: "300.00", currency: "INR" })).execute(a.admin, req.id), 409, /Shopify now reports only ₹300\.00 refundable on this order/);
      await rejects(exec(tx, api, async () => ({ amount: "0.00", currency: "INR" })).execute(a.admin, req.id), 409, /Shopify now reports only ₹0\.00/);
      await rejects(exec(tx, api, async () => ({ amount: "900.00", currency: "USD" })).execute(a.admin, req.id), 409, /different currency/);
      await rejects(exec(tx, api, async () => null).execute(a.admin, req.id), 503, /could not be confirmed/);
      await rejects(exec(tx, api, async () => { throw new Error("Shopify unreachable"); }).execute(a.admin, req.id), 503, /could not be confirmed/);
      assert.equal(sent, 0);
      const row = await tx.refundRequest.findUniqueOrThrow({ where: { id: req.id } });
      assert.deepEqual([row.status, row.executionStatus], [RefundRequestStatus.APPROVED, null], "still approved and untouched: it can be executed later");
    });
  });

  it("the existing safeguards are unchanged: only an approver executes, never the requester, and production stays blocked unless explicitly allowed", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const { req } = await approvedRequest(tx, a, "100");
      let sent = 0;
      const api: RefundApi = { createRefund: async () => { sent++; return answer(); }, getRefund: async () => answer() };
      const live = async () => ({ amount: SHOPIFY_REFUNDABLE, currency: "INR" });
      await rejects(exec(tx, api, live).execute(a.sales, req.id), 403);
      const prod = new RefundExecutionService(runnerOf(tx), { config: () => PRODUCTION, client: () => api, env: {}, shopifyRefundable: live });
      await rejects(prod.execute(a.admin, req.id), 403, /sandbox/);
      assert.equal(sent, 0);
    });
  });
});

describe("an order synced BEFORE the automatic step existed (the real #AWL101729 state: no Cashfree ids, no verification record, no Shopify amount)", () => {
  const noHook = async () => {}; // reproduces a sync that ran without the post-sync step
  const retry = async (tx: Db, w: World, node: Record<string, unknown>, a: Actors, s: { orderId: string; paymentId: string }) => {
    // what the "Retry Cashfree verification" endpoint does: verify, then re-read Shopify's refundable amount
    const resolver = new CashfreeIdResolutionService(runnerOf(tx), { shopify: () => new ShopifyReceiptReader(fakeShopify(w, node) as never), cashfreeConfig: () => w.config, cashfree: () => fakeCashfree(w) });
    const result = await resolver.resolve(a.sales, s.orderId, s.paymentId);
    const stored = await refreshShopifyRefundable(s.orderId, { client: fakeShopify(w, node) as never, runner: runnerOf(tx) });
    return { result, stored };
  };
  async function legacy(tx: Db, a: Actors, w: World, node = awlNode({ txId: TX })) {
    const r = await post(tx, w, node, a.admin, noHook);
    assert.equal(r.status, 200);
    const orderId: string = r.body.data.orderId;
    const lead = (await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { leadId: true } })).leadId;
    await tx.lead.update({ where: { id: lead }, data: { ownerId: a.sales.id, groupId: a.groupId } });
    return { orderId, paymentId: (await tx.payment.findFirstOrThrow({ where: { orderId } })).id, node };
  }

  it("shows exactly what the live order shows: not verified, retry offered, no Refund", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const s = await legacy(tx, a, world());
      assert.equal(await meta(tx, s.paymentId), null);
      const v = await view(tx, s.orderId);
      assert.deepEqual([v.eligible, v.canResolve, v.shopifyRefundableAmount], [false, true, null]);
      assert.equal(v.ineligibleReason, "The Cashfree payment of this Shopify order has not been verified yet, so it cannot be refunded here.");
    });
  });

  it("with the CRM on the Cashfree SANDBOX the retry fails safely for this LIVE payment - Cashfree is never contacted - and says exactly why", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const w = world({ config: SANDBOX, refundable: "820.00" });
      const s = await legacy(tx, a, w);
      const { result, stored } = await retry(tx, w, s.node, a, s);
      assert.equal(result.resolved, false);
      assert.match(result.reason!, /live payment, but the CRM is connected to the Cashfree sandbox/);
      assert.equal(w.calls.cashfree.length, 0);
      assert.equal(stored, true, "Shopify's amount is still read and stored");
      const v = await view(tx, s.orderId);
      assert.deepEqual([v.eligible, v.canResolve, v.shopifyRefundableAmount], [false, true, "820.00"]);
      assert.match(v.ineligibleReason!, /^Cashfree verification failed: This is a live payment, but the CRM is connected to the Cashfree sandbox/);
      assert.equal((await meta(tx, s.paymentId)).cashfree, undefined);
    });
  });

  it("once the CRM is on the Cashfree account that took the payment, the same retry verifies it and the Refund appears - capped by Shopify's own amount", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const w = world({ config: PRODUCTION, refundable: "820.00" });
      const s = await legacy(tx, a, w);
      const { result, stored } = await retry(tx, w, s.node, a, s);
      assert.deepEqual([result.resolved, result.cashfreeOrderId, result.cfPaymentId, stored], [true, ORDER_REF, CF_PAY, true]);
      assert.deepEqual(w.calls.cashfree, [ORDER_REF]);
      const v = await view(tx, s.orderId);
      assert.deepEqual([v.eligible, v.canResolve, v.ineligibleReason, v.refundableAmount, v.shopifyRefundableAmount], [true, false, null, "820.00", "820.00"]);
    });
  });

  it("verified ids but Shopify's amount never stored: not refundable, the retry is offered, and it reads Shopify's amount (the Cashfree ids are not asked for again)", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const w = world({ refundable: null });
      const s = await synced(tx, a, w); // the automatic step verifies Cashfree, but Shopify gives no refundable amount
      let v = await view(tx, s.orderId);
      assert.deepEqual([v.eligible, v.canResolve], [false, true]);
      assert.match(v.ineligibleReason!, /refundable amount for this order has not been confirmed yet/);
      w.refundable = "820.00";
      const { result, stored } = await retry(tx, w, s.node, a, s);
      assert.deepEqual([result.resolved, stored], [true, true]);
      assert.deepEqual(w.calls.cashfree, [ORDER_REF], "already verified: Cashfree is not asked again");
      v = await view(tx, s.orderId);
      assert.deepEqual([v.eligible, v.refundableAmount], [true, "820.00"]);
    });
  });
});

describe("a Shopify-originated order follows the same refund flow (request while active, approval cancels)", () => {
  it("an ACTIVE synced order (verified Cashfree, Shopify amount known) is refundable; requesting it cancels nothing; the manager's approval cancels it (the cancellation is injected here)", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const cancelled: string[] = [];
      const rs = new RefundsService(runnerOf(tx), { cancelOrder: async (_u, orderId) => { cancelled.push(orderId); await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED" } }); return { order: { status: "CANCELLED" }, shopify: { status: "cancelled" } }; } });
      const w = world();
      const active = awlNode({ cancelledAt: null, cancelReason: null, txId: TX });
      const s = await synced(tx, a, w, active);
      assert.equal((await meta(tx, s.paymentId)).cashfreeVerification.status, "VERIFIED");
      const v = await view(tx, s.orderId);
      assert.deepEqual([v.eligible, v.ineligibleReason, v.refundableAmount], [true, null, SHOPIFY_REFUNDABLE]);
      const req = await rs.createRequest(a.sales, s.orderId, { paymentId: s.paymentId, amount: "100", reason: "active order" });
      assert.equal(req.status, "PENDING");
      assert.notEqual((await tx.order.findUniqueOrThrow({ where: { id: s.orderId } })).status, "CANCELLED", "the request did not cancel the order");
      assert.equal(cancelled.length, 0);
      assert.equal((await rs.approve(a.manager, req.id)).status, "APPROVED");
      assert.deepEqual([cancelled, (await tx.order.findUniqueOrThrow({ where: { id: s.orderId } })).status], [[s.orderId], "CANCELLED"]);
    });
  });
});
