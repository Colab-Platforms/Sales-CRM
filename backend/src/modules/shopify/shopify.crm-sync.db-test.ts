// Shopify -> CRM order sync for refunds: a Shopify prepaid (Cashfree) order must become a proper CRM Order + Payment through the real upsert path, once,
// and then flow through the EXISTING refund system. Real schema, one rolled-back transaction per test, fake Shopify/Cashfree only. Run with: npm run test:db.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, OrderSource, PaymentMethod, PaymentStatus, Role } from "../../../generated/prisma/enums.js";
import type { Db, TxRunner } from "../integrations/integrations.common.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import type { CashfreeOrderPayment } from "../cashfree/cashfree.client.js";
import RefundsService, { loadOrderRefundInfo } from "../refunds/refunds.service.js";
import { ShopifyCashfreeAutoVerifier } from "../refunds/refunds.autoverify.js";
import CashfreeIdResolutionService, { type ShopifyReceipt } from "../refunds/refunds.resolve.js";
import OrdersLiveService from "../orders/orders.live.service.js";
import { codOrderNode, money, normalized, orderNode, rawTransaction } from "./shopify.fixtures.js";
import { mapOrder } from "./shopify.mapper.js";
import { upsertOrder } from "./shopify.persist.js";
import { syncOrderById, type OrderSyncOutcome } from "./shopify.sync.js";
import { makeSyncLiveOrder } from "../orders/orders.live.controller.js";
import type { Response } from "express";
import type { AuthRequest } from "@/middlewares/auth.js";

class Rollback extends Error {}
after(() => prisma.$disconnect());
const uid = () => randomUUID();
const SANDBOX = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret-not-real" });

async function inRollback(fn: (tx: Db, runner: TxRunner) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx, { $transaction: (cb) => cb(tx) }); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
const runnerOf = (tx: Db): TxRunner => ({ $transaction: (cb) => cb(tx) });

const digits = (n: number) => Array.from({ length: n }, () => randomInt(0, 10)).join("");
type U = { id: string; username: string; role: Role };

/** A Shopify order that is paid through Cashfree (the fixture default), with ids and a customer that exist nowhere else. */
function prepaidNode(over: Record<string, unknown> = {}) {
  const id = `9${digits(12)}`;
  const phone = `+91 9${digits(9)}`;
  return orderNode({
    id: `gid://shopify/Order/${id}`,
    name: `#AWL${digits(6)}`,
    customer: { id: `gid://shopify/Customer/8${digits(12)}`, firstName: "Asha", lastName: "Verma", email: `asha-${uid().slice(0, 8)}@example.invalid`, phone },
    email: null,
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: `gid://shopify/LineItem/${id}1`, title: "Herbal Masala", variantTitle: "60 pouches", sku: `SKU-${digits(5)}`, quantity: 1, originalUnitPriceSet: money("649.0"), discountAllocations: [], taxLines: [], product: { id: `gid://shopify/Product/7${digits(12)}` }, variant: { id: `gid://shopify/ProductVariant/6${digits(12)}` } }] },
    transactions: [rawTransaction({ id: `gid://shopify/OrderTransaction/${id}1`, gateway: "Cashfree", status: "SUCCESS", kind: "SALE", amountSet: money("649.0"), paymentId: `#AWL${digits(5)}.1` })],
    ...over,
  });
}
const shopifyId = (node: Record<string, unknown>) => String(node.id).split("/").pop()!;
const sync = (tx: Db, node: Record<string, unknown>, opts: { force?: boolean } = {}) => upsertOrder(tx, mapOrder(normalized(node)), { force: opts.force ?? true });

async function actors(tx: Db) {
  const mk = (name: string, role: Role) => tx.user.create({ data: { name, username: `${name.toLowerCase()}-${uid()}`, role }, select: { id: true, username: true } }).then((u) => ({ id: u.id, username: u.username, role }) as U);
  const [sales, manager, admin] = await Promise.all([mk("Tele", Role.SALESPERSON), mk("Mgr", Role.MANAGER), mk("Admin", Role.ADMIN)]);
  const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: manager.id }, select: { id: true } });
  await tx.groupMember.create({ data: { groupId: group.id, userId: sales.id, joinedAt: new Date(), isActive: true } });
  return { sales, manager, admin, groupId: group.id };
}
/** Puts the synced order's customer in the telecaller's group, as the lead owner assignment would. */
const assign = (tx: Db, leadId: string, a: Awaited<ReturnType<typeof actors>>) => tx.lead.update({ where: { id: leadId }, data: { ownerId: a.sales.id, groupId: a.groupId } });

const rejects = (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => { assert.equal(e.statusCode, status, e.message); if (re) assert.match(e.message, re); return true; });

describe("a Shopify prepaid Cashfree order becomes a CRM Order + Payment", () => {
  it("creates the order, items, customer link and payment with Shopify's own references, and nothing refund-related", async () => {
    await inRollback(async (tx) => {
      const node = prepaidNode();
      const r = await sync(tx, node);
      assert.equal(r.action, "created");
      const order = await tx.order.findUniqueOrThrow({ where: { id: r.orderId! }, include: { items: true, payments: true, lead: true } });
      assert.deepEqual([order.externalSource, order.externalId, order.source], ["SHOPIFY", shopifyId(node), OrderSource.SHOPIFY]);
      assert.equal(order.externalNumber, node.name);
      assert.equal(order.totalAmount.toString(), "649");
      assert.equal(order.items.length, 1);
      assert.equal(order.lead.id, r.lead!.leadId, "the customer's lead is linked");
      assert.equal((order.metadata as any).paymentMode, "PREPAID");
      assert.equal(order.payments.length, 1);
      const p = order.payments[0]!;
      assert.deepEqual([p.externalSource, p.provider, p.status, p.amount.toString(), p.refundedAmount], ["SHOPIFY", "Cashfree", PaymentStatus.SUCCESS, "649", null]);
      assert.ok(p.paidAt);
      // Shopify's payment reference is kept as Shopify's - it is NOT a Cashfree id and nothing claims it is
      assert.match(p.providerPaymentId ?? "", /^#AWL\d+\.1$/);
      assert.equal(p.metadata, null, "no Cashfree identifier is invented by the sync");
      assert.equal(await tx.refundRequest.count({ where: { orderId: order.id } }), 0, "a sync never raises a refund");
    });
  });

  it("is idempotent: syncing the same Shopify order again (forced or not, or after a change) never creates a second order, item set or payment", async () => {
    await inRollback(async (tx) => {
      const node = prepaidNode();
      const first = await sync(tx, node);
      const again = await sync(tx, node);
      const unchanged = await sync(tx, node, { force: false });
      const changed = await sync(tx, { ...node, updatedAt: "2026-09-20T10:00:00Z", tags: ["Cashfree", "prepaid", "UPI", "vip"] }, { force: false });
      assert.deepEqual([again.action, unchanged.action, changed.action], ["updated", "skipped", "updated"]);
      assert.deepEqual([again.orderId, unchanged.orderId, changed.orderId], [first.orderId, first.orderId, first.orderId]);
      const where = { externalSource: "SHOPIFY" as const, externalId: shopifyId(node) };
      assert.equal(await tx.order.count({ where }), 1);
      assert.equal(await tx.orderItem.count({ where: { orderId: first.orderId! } }), 1);
      assert.equal(await tx.payment.count({ where: { orderId: first.orderId! } }), 1);
      assert.equal(await tx.lead.count({ where: { id: first.lead!.leadId } }), 1);
    });
  });

  it("COD keeps its existing behaviour: a CRM order with a pending COD payment, never refundable", async () => {
    await inRollback(async (tx) => {
      const id = `9${digits(12)}`;
      const r = await sync(tx, codOrderNode({ id: `gid://shopify/Order/${id}`, name: `#AWL${digits(6)}`, customer: { id: `gid://shopify/Customer/8${digits(12)}`, firstName: "Ravi", lastName: "K", email: `r-${uid().slice(0, 8)}@example.invalid`, phone: `+91 9${digits(9)}` }, transactions: [rawTransaction({ id: `gid://shopify/OrderTransaction/${id}1`, gateway: "Cash on Delivery (COD)", status: "PENDING", kind: "SALE", amountSet: money("699.0"), paymentId: "cod_1" })] }));
      assert.equal(r.action, "created");
      const order = await tx.order.findUniqueOrThrow({ where: { id: r.orderId! }, include: { payments: true } });
      assert.equal((order.metadata as any).paymentMode, "COD");
      assert.deepEqual([order.payments[0]!.method, order.payments[0]!.status], [PaymentMethod.COD, PaymentStatus.PENDING]);
      const view = (await loadOrderRefundInfo(tx, order.id)).payments[0]!;
      assert.deepEqual([view.eligible, view.canResolve], [false, false]);
    });
  });

  it("unpaid / failed Shopify payments sync but are not refundable and not looked up", async () => {
    await inRollback(async (tx) => {
      for (const status of ["PENDING", "FAILURE"]) {
        const node = prepaidNode({ displayFinancialStatus: "PENDING" });
        const id = shopifyId(node);
        (node.transactions as any[])[0] = rawTransaction({ id: `gid://shopify/OrderTransaction/${id}1`, gateway: "Cashfree", status, kind: "SALE", amountSet: money("649.0"), paymentId: null });
        const r = await sync(tx, node);
        const view = (await loadOrderRefundInfo(tx, r.orderId!)).payments[0]!;
        assert.deepEqual([view.eligible, view.canResolve], [false, false], status);
      }
    });
  });
});

describe("the synced order flows through the EXISTING refund system", () => {
  const receipt = (over: Partial<ShopifyReceipt> = {}): ShopifyReceipt => ({ gateway: "Cashfree", receiptPaymentId: "6443901832", authorizationCode: "ShOrder777", kind: "SALE", status: "SUCCESS", test: null, cashfreeTxnId: null, ...over });
  const cfPay = (over: Partial<CashfreeOrderPayment> = {}): CashfreeOrderPayment => ({ cfPaymentId: "6443901832", paymentStatus: "SUCCESS", paymentAmount: "649", bankReference: "B1", paymentGroup: "upi", paymentTime: null, ...over });
  const resolver = (tx: Db, r: ShopifyReceipt | null, pays: CashfreeOrderPayment[]) =>
    new CashfreeIdResolutionService(runnerOf(tx), { shopify: () => ({ getTransactionReceipt: async () => r }), cashfreeConfig: () => SANDBOX, cashfree: () => ({ getOrderPayments: async () => pays }) });

  /** The post-sync step with fakes: Shopify's refundable amount and the Cashfree answers. */
  const verifier = (tx: Db, r: ShopifyReceipt | null, pays: CashfreeOrderPayment[], refundable: string | null = "649.00") =>
    new ShopifyCashfreeAutoVerifier(runnerOf(tx), { refundable: async () => (refundable === null ? null : { amount: refundable, currency: "INR" }), resolver: resolver(tx, r, pays) });

  it("synced -> not refundable until the automatic Cashfree verification succeeds; verified ids and Shopify's amount survive every later sync; then SALESPERSON, MANAGER and ADMIN can each request", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const node = prepaidNode({ cancelledAt: "2026-10-07T06:40:00Z", cancelReason: "CUSTOMER" }); // a refund needs a cancelled order
      const first = await sync(tx, node);
      await assign(tx, first.lead!.leadId, a);
      const paymentId = (await tx.payment.findFirstOrThrow({ where: { orderId: first.orderId! } })).id;
      const rs = new RefundsService(runnerOf(tx));

      // 1. Just synced (the post-sync step has not run): a request is refused, Shopify's reference is never taken as a cf_payment_id
      const before = (await loadOrderRefundInfo(tx, first.orderId!)).payments[0]!;
      assert.deepEqual([before.eligible, before.canResolve], [false, true]);
      await rejects(rs.createRequest(a.sales, first.orderId!, { paymentId, amount: "10", reason: "x" }), 400, /not been verified/);

      // 2. The automatic step: mismatching Cashfree data saves no ids (the failure is recorded and explained); matching data saves them - no manual lookup involved
      const bad = await verifier(tx, receipt(), [cfPay({ paymentAmount: "1" })]).afterOrderSync(first.orderId!);
      assert.deepEqual([bad.verified.length, bad.failed.length, bad.refundableStored], [0, 1, true]);
      const failedRow = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      assert.equal((failedRow.metadata as any).cashfree, undefined);
      assert.equal((failedRow.metadata as any).cashfreeVerification.status, "FAILED");
      assert.match((await loadOrderRefundInfo(tx, first.orderId!)).payments[0]!.ineligibleReason!, /^Cashfree verification failed/);
      const good = await verifier(tx, receipt(), [cfPay()]).afterOrderSync(first.orderId!);
      assert.deepEqual([good.verified, good.failed.length], [[paymentId], 0]);

      // 3. A later Shopify sync (changed order) keeps the verified ids, Shopify's refundable amount and the payment's status
      await sync(tx, { ...node, updatedAt: "2026-09-21T10:00:00Z" }, { force: false });
      assert.equal(((await tx.order.findUniqueOrThrow({ where: { id: first.orderId! } })).metadata as any).shopifyRefundable.amount, "649.00");
      const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      assert.equal((p.metadata as any).cashfree.cashfreeOrderId, "ShOrder777");
      assert.equal((p.metadata as any).cashfree.cfPaymentId, "6443901832");
      assert.equal(p.status, PaymentStatus.SUCCESS);
      assert.equal((await loadOrderRefundInfo(tx, first.orderId!)).payments[0]!.eligible, true);

      // 4. The existing workflow: telecaller requests, manager approves; admin can also request
      const req = await rs.createRequest(a.sales, first.orderId!, { paymentId, amount: "100", reason: "Customer returned the product" });
      assert.equal(req.status, "PENDING");
      assert.equal((await rs.approve(a.manager, req.id)).status, "APPROVED");
      assert.equal((await rs.createRequest(a.manager, first.orderId!, { paymentId, amount: "50", reason: "manager raised" })).status, "PENDING");
      assert.equal((await rs.createRequest(a.admin, first.orderId!, { paymentId, amount: "25", reason: "admin raised" })).status, "PENDING");
      assert.equal(await tx.refundRequest.count({ where: { orderId: first.orderId! } }), 3);
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedAmount, null, "requesting moves no money");
    });
  });
});

describe("bringing a live-only Shopify order into the CRM on demand (ADMIN)", () => {
  const outcome = (r: Awaited<ReturnType<typeof sync>> | null, notFound = false): OrderSyncOutcome => ({ notFound, outOfWindow: false, mapped: null, result: r, productsSynced: 0, productResults: [] });

  it("runs the normal sync once per call, without lifecycle automation, and returns the CRM order to open", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const node = prepaidNode();
      const calls: { gid: string; opts: any }[] = [];
      const svc = new OrdersLiveService(prisma, () => ({}) as never, runnerOf(tx), async (_deps, gid, opts) => { calls.push({ gid, opts }); return outcome(await sync(tx, node, { force: false })); });
      const first = await svc.syncLiveOrderToCrm(a.admin, shopifyId(node));
      assert.deepEqual([first.synced, first.action], [true, "created"]);
      assert.equal(first.orderId, (await tx.order.findFirstOrThrow({ where: { externalSource: "SHOPIFY", externalId: shopifyId(node) } })).id);
      assert.deepEqual([calls[0]!.gid, calls[0]!.opts.automation, calls[0]!.opts.source], [`gid://shopify/Order/${shopifyId(node)}`, false, ActivitySource.SHOPIFY_SYNC]);
      const second = await svc.syncLiveOrderToCrm(a.admin, shopifyId(node));
      assert.deepEqual([second.synced, second.orderId, second.action], [true, first.orderId, "skipped"]);
      assert.equal(await tx.order.count({ where: { externalSource: "SHOPIFY", externalId: shopifyId(node) } }), 1, "no duplicate");
    });
  });

  it("only an ADMIN may; Shopify problems and a vanished order change nothing and say why", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      let ran = 0;
      const mk = (impl: () => Promise<OrderSyncOutcome>, client: () => never = () => ({}) as never) => new OrdersLiveService(prisma, client, runnerOf(tx), async () => { ran++; return impl(); });
      for (const u of [a.sales, a.manager]) assert.deepEqual(await mk(async () => outcome(null)).syncLiveOrderToCrm(u, "123"), { synced: false, reason: "Not found" });
      assert.equal(ran, 0, "non-admins never reach the sync");
      assert.deepEqual(await mk(async () => outcome(null, true)).syncLiveOrderToCrm(a.admin, "123"), { synced: false, reason: "Shopify no longer has this order." });
      const failed = await mk(async () => { throw new Error("socket hang up shpat_SECRET"); }).syncLiveOrderToCrm(a.admin, "123");
      assert.equal(failed.synced, false);
      assert.doesNotMatch(failed.reason!, /shpat_|socket/, "no internals or credentials in the message");
      const { ShopifyConfigError } = await import("./shopify.config.js");
      const noConfig = await mk(async () => outcome(null), () => { throw new ShopifyConfigError("SHOPIFY_STORE_DOMAIN is not set"); }).syncLiveOrderToCrm(a.admin, "123");
      assert.equal(noConfig.synced, false);
    });
  });
});

describe("regression: #AWL101729 - the exact id the live page uses syncs end to end (real handler, service, syncOrderById and upsert; only Shopify is faked)", () => {
  // The live page loads the order with GET /orders/live/<externalId>; the Sync button POSTs the SAME <externalId>.
  const EXTERNAL_ID = "6571234567890";
  const awl101729 = () =>
    orderNode({
      id: `gid://shopify/Order/${EXTERNAL_ID}`,
      name: "#AWL101729",
      subtotalPriceSet: money("820.0"),
      totalPriceSet: money("820.0"),
      customer: { id: `gid://shopify/Customer/8${digits(12)}`, firstName: "Meera", lastName: "Nair", email: `meera-${uid().slice(0, 8)}@example.invalid`, phone: `+91 9${digits(9)}` },
      email: null,
      // No product / variant ids: the sync then needs no product fetch, so the fake client only has to answer the one order query.
      lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: `gid://shopify/LineItem/${EXTERNAL_ID}1`, title: "Herbal Masala", variantTitle: "120 pouches", sku: "SKU-AWL-120", quantity: 1, originalUnitPriceSet: money("820.0"), discountAllocations: [], taxLines: [], product: null, variant: null }] },
      // Shopify reports no gateway payment id here, so the CRM keeps Shopify's own transaction id as the reference.
      transactions: [rawTransaction({ id: "gid://shopify/OrderTransaction/20808276639933", gateway: "Cashfree", status: "SUCCESS", kind: "SALE", amountSet: money("820.0"), paymentId: null })],
    });

  async function post(tx: Db, a: Awaited<ReturnType<typeof actors>>, externalId: string, user: U, node = awl101729()) {
    const asked: string[] = [];
    const client = { query: async (_doc: string, vars: { id?: string }) => { asked.push(String(vars.id)); return { order: node }; } };
    const opts: any[] = [];
    const service = new OrdersLiveService(prisma, () => client as never, runnerOf(tx), (deps, gid, o) => { opts.push(o); return syncOrderById(deps, gid, o); }, () => undefined);
    const out: { status?: number; body?: any } = {};
    const res = { status: (s: number) => ({ json: (b: unknown) => { out.status = s; out.body = b; } }) } as unknown as Response;
    await makeSyncLiveOrder(service)({ params: { externalId }, user } as unknown as AuthRequest, res);
    void a;
    return { ...out, asked, opts };
  }

  it("creates the CRM order once with the exact Shopify id, items, customer link and payment; a second click reuses it; no automation; refund still needs verified Cashfree ids", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const first = await post(tx, a, EXTERNAL_ID, a.admin);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.deepEqual([first.body.data.synced, first.body.data.action], [true, "created"]);
      assert.deepEqual(first.asked, [`gid://shopify/Order/${EXTERNAL_ID}`], "Shopify was asked for exactly this order, by its exact GID");
      assert.equal(first.opts[0].automation, false, "no WhatsApp lifecycle automation");

      const order = await tx.order.findUniqueOrThrow({ where: { id: first.body.data.orderId }, include: { items: true, payments: true, lead: true } });
      assert.deepEqual([order.externalSource, order.externalId, order.externalNumber, order.source], ["SHOPIFY", EXTERNAL_ID, "#AWL101729", OrderSource.SHOPIFY]);
      assert.equal(order.totalAmount.toString(), "820");
      assert.equal(order.items.length, 1);
      assert.equal(order.lead.firstName, "Meera");
      const p = order.payments[0]!;
      assert.deepEqual([order.payments.length, p.provider, p.status, p.amount.toString(), p.transactionReference, p.externalSource], [1, "Cashfree", PaymentStatus.SUCCESS, "820", "20808276639933", "SHOPIFY"]);
      assert.equal(p.metadata, null, "Shopify's transaction id is not recorded as a Cashfree id");
      assert.equal(await tx.refundRequest.count({ where: { orderId: order.id } }), 0);

      // Cashfree verification is still required: the lookup is offered, an executable refund is not
      const view = (await loadOrderRefundInfo(tx, order.id)).payments[0]!;
      assert.deepEqual([view.eligible, view.canResolve], [false, true]);

      // clicking Sync again: same order, nothing duplicated
      const second = await post(tx, a, EXTERNAL_ID, a.admin);
      assert.equal(second.status, 200);
      assert.equal(second.body.data.orderId, first.body.data.orderId);
      assert.equal(await tx.order.count({ where: { externalSource: "SHOPIFY", externalId: EXTERNAL_ID } }), 1);
      assert.equal(await tx.payment.count({ where: { orderId: order.id } }), 1);
      assert.equal(await tx.orderItem.count({ where: { orderId: order.id } }), 1);
    });
  });

  it("a telecaller (SALESPERSON) or manager gets nothing - and Shopify is never even asked", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      for (const u of [a.sales, a.manager]) {
        const r = await post(tx, a, EXTERNAL_ID, u);
        assert.equal(r.status, 404);
        assert.equal(r.asked.length, 0);
      }
      assert.equal(await tx.order.count({ where: { externalSource: "SHOPIFY", externalId: EXTERNAL_ID } }), 0);
    });
  });
});
