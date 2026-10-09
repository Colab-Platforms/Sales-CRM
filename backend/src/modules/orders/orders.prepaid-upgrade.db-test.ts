// Prepaid Upgrade (COD -> prepaid at a telecaller-offered discount): the real service + the real CashfreePaymentsService and
// applyPaymentUpdate (the same function the webhook calls), with the Cashfree API faked. Nothing leaves the process. Every
// test runs in ONE transaction that is always rolled back. Run with: npm run test:db
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, Role } from "../../../generated/prisma/enums.js";
import { type Db, type TxRunner } from "../integrations/integrations.common.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import type { CashfreeLink } from "../cashfree/cashfree.client.js";
import CashfreePaymentsService, { type CashfreeApi } from "../cashfree/cashfree.payments.service.js";
import { applyPaymentUpdate } from "../cashfree/cashfree.apply.js";
import { derivePaymentMode, derivePaymentStatus } from "./orders.filters.js";
import PrepaidUpgradeService from "./orders.prepaid-upgrade.service.js";
import { setDefaultOffersSource } from "../discounts/discounts.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Db, runner: TxRunner) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx, { $transaction: (cb) => cb(tx) }); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });
const NOW = new Date("2026-09-25T12:00:00.000Z");
const CONFIG = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: "CFID_TEST", CASHFREE_CLIENT_SECRET: "cfsk_ma_test_SECRET0123456789", PUBLIC_BACKEND_URL: "https://crm.example.com" });

async function setup(tx: Db, runner: TxRunner, opts: { total?: string; method?: "COD" | "UPI"; status?: string; shopify?: boolean; metadataOnlyCod?: boolean; codPaid?: boolean } = {}) {
  const total = opts.total ?? "1249.00";
  const tele = await tx.user.create({ data: { name: "Tele Caller", username: `t-${uid()}`, role: Role.SALESPERSON } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", mobile: "9000000123", normalizedMobile: "+919000000123", email: "p@zz.invalid", ownerId: tele.id }, select: { id: true } });
  const method = opts.method ?? "COD";
  const order = await tx.order.create({
    data: {
      orderNumber: `ORD-${uid()}`, leadId: lead.id, createdById: tele.id, source: opts.shopify ? "SHOPIFY" : "SALESPERSON", status: (opts.status ?? "CONFIRMED") as never,
      ...(opts.shopify ? { externalSource: "SHOPIFY" as const, externalId: `gid://shopify/Order/${uid()}`, externalNumber: "#AWL1" } : {}),
      subtotal: total, totalAmount: total, discountAmount: "0", metadata: { paymentMode: method === "COD" ? "COD" : "PREPAID" },
      // Shopify-synced COD orders carry a synthetic payment: method COD, status PENDING, externalSource SHOPIFY (see shopify.mapper.ts synthesizePayment).
      ...(opts.metadataOnlyCod ? {} : { payments: { create: { amount: total, currency: "INR", method, status: method === "COD" ? (opts.codPaid ? "SUCCESS" : "PENDING") : "SUCCESS", ...(opts.shopify ? { externalSource: "SHOPIFY" as const, externalId: `synthetic-${uid()}` } : {}) } } }),
    },
    select: { id: true },
  });
  const created: { request: { link_amount: number } }[] = [];
  const link = (id: string, status = "ACTIVE"): CashfreeLink => ({ cfLinkId: "1", linkId: id, linkStatus: status, linkUrl: `https://pay.test/${id}`, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null });
  const api: CashfreeApi = {
    createLink: async (request) => { created.push({ request: request as never }); return link(request.link_id); },
    getLink: async (id) => link(id),
    cancelLink: async (id) => link(id, "CANCELLED"),
  };
  const cashfree = new CashfreePaymentsService(runner, { config: () => CONFIG, client: () => api, now: () => NOW });
  const svc = new PrepaidUpgradeService(tx as never, () => cashfree, () => NOW);
  const user = as(tele, Role.SALESPERSON);
  const reload = async () => {
    const o = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { totalAmount: true, discountAmount: true, status: true, metadata: true, payments: { select: { id: true, method: true, status: true, amount: true, metadata: true, externalSource: true } } } });
    return { ...o, mode: derivePaymentMode(o.payments), payStatus: derivePaymentStatus(o.payments) };
  };
  // What the Cashfree webhook processor does on a PAID link.
  const pay = (paymentId: string, paidAmount: string) => applyPaymentUpdate(tx, paymentId, { status: "SUCCESS", paidAmount, cfPaymentId: "cf_1" }, { source: ActivitySource.CASHFREE_WEBHOOK, now: NOW });
  const fail = (paymentId: string, reason = "Payment link expired") => applyPaymentUpdate(tx, paymentId, { status: "FAILED", failureReason: reason }, { source: ActivitySource.CASHFREE_WEBHOOK, now: NOW });
  return { tele, user, order, svc, created, reload, pay, fail, tx };
}

describe("offer creation (no conversion yet)", () => {
  it("1249 - 100 = 1149 fixed; the COD order is untouched; amounts come from the server", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const r = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      assert.equal(r.eligible, true);
      assert.deepEqual([r.offer!.status, r.offer!.originalAmount, r.offer!.discountAmount, r.offer!.prepaidAmount], ["OFFERED", "1249", "100.00", "1149.00"]);
      assert.equal(r.offer!.createdById, t.tele.id);
      const o = await t.reload();
      assert.equal(Number(o.totalAmount), 1249, "original amount NOT overwritten");
      assert.equal(o.mode, "COD");
      assert.equal(t.created.length, 0, "creating an offer sends nothing to the payment provider");
    });
  });
  it("percentage offer: 10% of 1249 = 124.90 -> 1124.10", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const r = await t.svc.createOffer(t.user, t.order.id, { discountType: "PERCENT", discountValue: "10" });
      assert.deepEqual([r.offer!.discountAmount, r.offer!.prepaidAmount], ["124.90", "1124.10"]);
    });
  });
  it("invalid discounts are rejected and nothing is stored", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const reject = async (discountType: "FIXED" | "PERCENT", discountValue: string, re: RegExp) => {
        await assert.rejects(() => t.svc.createOffer(t.user, t.order.id, { discountType, discountValue }), (e: any) => e.statusCode === 400 && re.test(e.message), `${discountType} ${discountValue}`);
      };
      await reject("FIXED", "0", /greater than 0/);
      await reject("FIXED", "-5", /negative/);
      await reject("FIXED", "abc", /valid discount/);
      await reject("FIXED", "1249", /greater than or equal/);
      await reject("FIXED", "5000", /greater than or equal/);
      await reject("PERCENT", "100", /greater than or equal/);
      await reject("PERCENT", "101", /cannot exceed 100/);
      await reject("PERCENT", "0", /greater than 0/);
      assert.equal((await t.svc.getUpgrade(t.user, t.order.id)).offer, null);
    });
  });
  it("a prepaid order, and a cancelled order, cannot receive an offer", async () => {
    await inRollback(async (tx, runner) => {
      const prepaid = await setup(tx, runner, { method: "UPI" });
      await assert.rejects(() => prepaid.svc.createOffer(prepaid.user, prepaid.order.id, { discountType: "FIXED", discountValue: "50" }), (e: any) => e.statusCode === 400);
      assert.equal((await prepaid.svc.getUpgrade(prepaid.user, prepaid.order.id)).eligible, false);
      const cancelled = await setup(tx, runner, { status: "CANCELLED" });
      await assert.rejects(() => cancelled.svc.createOffer(cancelled.user, cancelled.order.id, { discountType: "FIXED", discountValue: "50" }), /cancelled/);
    });
  });
});

describe("payment link and conversion", () => {
  it("generating the link sends the SERVER-computed amount to Cashfree and does NOT convert COD", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o1 = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      const r = await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      assert.equal(t.created.length, 1);
      assert.equal(t.created[0]!.request.link_amount, 1149, "Cashfree is asked for the discounted amount, not 1249");
      assert.equal(r.offer!.status, "PAYMENT_PENDING");
      assert.ok(r.offer!.paymentUrl && r.paymentId);
      const o = await t.reload();
      assert.equal(o.mode, "COD", "still COD after the link exists");
      assert.equal(Number(o.totalAmount), 1249, "amount still the original COD amount");
      assert.equal(o.payStatus, "PENDING");
    });
  });
  it("verified payment converts COD -> prepaid: total 1149, discount recorded, PAID, history kept", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o1 = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      const r = await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      await t.pay(r.paymentId!, "1149.00");
      const o = await t.reload();
      assert.equal(o.mode, "PREPAID");
      assert.equal(o.payStatus, "SUCCESS");
      assert.equal(Number(o.totalAmount), 1149);
      assert.equal(Number(o.discountAmount), 100);
      assert.equal((o.metadata as any).paymentMode, "PREPAID");
      assert.equal((o.metadata as any).prepaidUpgrade.status, "UPGRADED");
      assert.equal((o.metadata as any).prepaidUpgrade.originalAmount, "1249");
      const cod = o.payments.find((p) => p.status === "FAILED");
      assert.equal((cod!.metadata as any).retiredByPrepaidUpgrade.originalMethod, "COD", "the COD placeholder is kept and annotated, not deleted");
      assert.equal(await tx.activity.count({ where: { orderId: t.order.id, title: "Prepaid upgrade completed: COD -> Prepaid" } }), 1);
    });
  });
  it("a duplicate success callback does not upgrade twice (no double discount)", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o1 = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      const r = await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      await t.pay(r.paymentId!, "1149.00");
      await t.pay(r.paymentId!, "1149.00");
      const o = await t.reload();
      assert.equal(Number(o.discountAmount), 100);
      assert.equal(Number(o.totalAmount), 1149);
      assert.equal(await tx.activity.count({ where: { orderId: t.order.id, title: "Prepaid upgrade completed: COD -> Prepaid" } }), 1);
    });
  });
  it("failed or expired payment keeps COD, reopens the offer, and a new link can be generated", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o1 = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      const r = await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      await t.fail(r.paymentId!, "Payment link expired");
      const o = await t.reload();
      assert.equal(o.mode, "COD");
      assert.equal(Number(o.totalAmount), 1249);
      assert.equal((o.metadata as any).prepaidUpgrade.status, "OFFERED");
      assert.equal((o.metadata as any).prepaidUpgrade.lastPaymentFailure.reason, "Payment link expired");
      const again = await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      assert.equal(again.offer!.status, "PAYMENT_PENDING");
      assert.notEqual(again.paymentId, r.paymentId);
    });
  });
  it("one live offer per order: creating while a link is pending returns the existing offer", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o1 = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      const second = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "300" });
      assert.equal(second.reused, true);
      assert.equal(second.offer!.id, o1.offer!.id);
      assert.equal(second.offer!.prepaidAmount, "1149.00", "not silently re-priced");
    });
  });
  it("re-generating the link for the same pending offer reuses the open link (no second Cashfree request)", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o1 = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      const a = await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      const b = await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      assert.equal(t.created.length, 1);
      assert.equal(b.reused, true);
      assert.equal(a.paymentId, b.paymentId);
    });
  });
  it("an un-sent offer can be replaced by a new one (old one kept in history)", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      const second = await t.svc.createOffer(t.user, t.order.id, { discountType: "PERCENT", discountValue: "5" });
      assert.equal(second.offer!.discountAmount, "62.45");
      assert.equal(second.history.length, 1);
    });
  });
  it("cancelled order: a late successful payment is recorded as PAYMENT_RECEIVED but never converts or reactivates the order", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o1 = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      const r = await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      await tx.order.update({ where: { id: t.order.id }, data: { status: "CANCELLED" } });
      await t.pay(r.paymentId!, "1149.00");
      const o = await t.reload();
      assert.equal(o.status, "CANCELLED");
      assert.equal(Number(o.totalAmount), 1249, "not converted");
      assert.equal((o.metadata as any).prepaidUpgrade.status, "PAYMENT_RECEIVED");
      assert.match((o.metadata as any).prepaidUpgrade.note, /cancelled/);
    });
  });
  it("an amount that differs from the approved prepaid amount is not converted", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o1 = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      const r = await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      await t.pay(r.paymentId!, "1000.00");
      const o = await t.reload();
      assert.equal(Number(o.totalAmount), 1249);
      assert.equal((o.metadata as any).prepaidUpgrade.status, "PAYMENT_RECEIVED");
    });
  });
  it("declining keeps COD, cancels the open link, and the offer stays in history", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o1 = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      const r = await t.svc.decline(t.user, t.order.id, o1.offer!.id);
      assert.equal(r.offer!.status, "DECLINED");
      const o = await t.reload();
      assert.equal(o.mode, "COD");
      assert.equal(Number(o.totalAmount), 1249);
      // a declined offer can be replaced by a fresh one
      const next = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "50" });
      assert.equal(next.offer!.status, "OFFERED");
      assert.equal(next.history[0]!.status, "DECLINED");
    });
  });
  it("a stale offer id cannot be used to generate a link", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      await assert.rejects(() => t.svc.generateLink(t.user, t.order.id, uid()), (e: any) => e.statusCode === 409);
      assert.equal(t.created.length, 0);
    });
  });
});

describe("permissions", () => {
  it("a salesperson can READ another salesperson's upgrade panel but cannot ACT on the order (404, nothing changed); an admin can", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const stranger = await tx.user.create({ data: { name: "Other", username: `o-${uid()}`, role: Role.SALESPERSON } });
      const s = as(stranger, Role.SALESPERSON);
      assert.equal((await t.svc.getUpgrade(s, t.order.id)).offer, null); // reading is company-wide
      await assert.rejects(() => t.svc.createOffer(s, t.order.id, { discountType: "FIXED", discountValue: "100" }), (e: any) => e.statusCode === 404);
      assert.equal((await t.svc.getUpgrade(t.user, t.order.id)).offer, null);
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const r = await t.svc.createOffer(as(admin, Role.ADMIN), t.order.id, { discountType: "FIXED", discountValue: "100" });
      assert.equal(r.offer!.status, "OFFERED");
    });
  });
});

describe("real-world COD representations are recognised (what the Order Detail page actually sees)", () => {
  it("a Shopify-synced COD order (source SHOPIFY, payment COD/PENDING/externalSource SHOPIFY, metadata COD) is eligible and isCod", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { shopify: true });
      const v = await t.svc.getUpgrade(t.user, t.order.id);
      assert.deepEqual([v.eligible, v.isCod, v.reason], [true, true, null]);
      assert.equal(v.orderAmount, "1249");
      // the whole flow works on it too, and the Shopify-source payment row is left alone when COD is retired
      const o1 = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      const r = await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      await t.pay(r.paymentId!, "1149.00");
      assert.equal((await t.reload()).mode, "PREPAID");
    });
  });
  it("COD recorded only in order metadata (no COD payment row) is still recognised as COD", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { shopify: true, metadataOnlyCod: true });
      const v = await t.svc.getUpgrade(t.user, t.order.id);
      assert.deepEqual([v.eligible, v.isCod], [true, true]);
    });
  });
  it("COD already collected (payment SUCCESS): isCod stays true so the page can explain why, but it is not eligible", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { shopify: true, codPaid: true, status: "DELIVERED" });
      const v = await t.svc.getUpgrade(t.user, t.order.id);
      assert.deepEqual([v.eligible, v.isCod], [false, true]);
      assert.match(v.reason!, /successful payment/);
    });
  });
  it("a prepaid order is neither eligible nor COD (the card stays hidden)", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { method: "UPI", shopify: true });
      const v = await t.svc.getUpgrade(t.user, t.order.id);
      assert.deepEqual([v.eligible, v.isCod], [false, false]);
    });
  });
  it("after an upgrade the order reads as prepaid: isCod false, offer shows UPGRADED", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o1 = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" });
      const r = await t.svc.generateLink(t.user, t.order.id, o1.offer!.id);
      await t.pay(r.paymentId!, "1149.00");
      const v = await t.svc.getUpgrade(t.user, t.order.id);
      assert.deepEqual([v.isCod, v.offer!.status], [false, "UPGRADED"]);
    });
  });
});

describe("Prepaid Upgrade: custom ₹50 default, custom edits and Fastrr coupons (1249 original)", () => {
  const fastrr = (o: Record<string, unknown>) => ({ id: "fr-1", couponCode: "FASTRR100", discountType: "flat", discountValue: 100, automaticDiscount: false, startTime: null, endTime: null, active: true, minCartTotal: null, minQtyProduct: null, productFilter: null, expiringSoon: false, ...o });
  const useFastrr = (offers: unknown[]) => setDefaultOffersSource({ getActiveOffers: async () => ({ offers: offers as never, fetchedAt: new Date().toISOString() }) });
  after(() => setDefaultOffersSource(null));

  it("default custom ₹50: customer pays 1199, the Cashfree link is for 1199, and a verified payment converts at 1199 with the reason persisted", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "50", expectedPrepaidAmount: "1199.00" });
      assert.deepEqual([o.offer!.discountAmount, o.offer!.prepaidAmount, o.offer!.couponCode, o.offer!.discountSource, o.offer!.wasDefault], ["50.00", "1199.00", null, "CUSTOM", true]);
      const r = await t.svc.generateLink(t.user, t.order.id, o.offer!.id);
      assert.equal(t.created[0]!.request.link_amount, 1199, "Cashfree gets the discounted amount");
      assert.equal(Number((await t.reload()).totalAmount), 1249, "still COD at the original amount until paid");
      await t.pay(r.paymentId!, "1199.00");
      const after = await t.reload();
      assert.deepEqual([after.mode, Number(after.totalAmount), Number(after.discountAmount)], ["PREPAID", 1199, 50]);
      assert.equal((after.metadata as any).prepaidUpgrade.couponCode, null);
    });
  });
  it("Edit 50 -> 100 replaces the default (1149, not 1099); custom 10% gives 1124.10; custom 120 gives 1129", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      assert.equal((await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "100" })).offer!.prepaidAmount, "1149.00");
      assert.equal((await t.svc.createOffer(t.user, t.order.id, { discountType: "PERCENT", discountValue: "10" })).offer!.prepaidAmount, "1124.10");
      const custom = await t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "120" });
      assert.deepEqual([custom.offer!.prepaidAmount, custom.offer!.discountSource, custom.offer!.couponId], ["1129.00", "CUSTOM", null]);
      assert.equal(custom.history.length, 2, "earlier choices are kept as history, never summed");
    });
  });
  it("Fastrr coupon: Fastrr's value applies, source/code/id are persisted, and the payment link uses the final amount", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      useFastrr([fastrr({})]);
      const o = await t.svc.createOffer(t.user, t.order.id, { couponCode: "FASTRR100", expectedPrepaidAmount: "1149.00" });
      assert.deepEqual([o.offer!.discountAmount, o.offer!.prepaidAmount, o.offer!.couponCode, o.offer!.couponId, o.offer!.couponSource, o.offer!.discountSource], ["100.00", "1149.00", "FASTRR100", "fr-1", "FASTRR", "FASTRR"]);
      await t.svc.generateLink(t.user, t.order.id, o.offer!.id);
      assert.equal(t.created[0]!.request.link_amount, 1149);
    });
  });
  it("security: old CRM codes, unknown/inactive Fastrr coupons, frontend numbers on a coupon and a mismatching expected amount are refused, and nothing is stored", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      useFastrr([fastrr({})]);
      for (const old of ["SAVE50", "SAVE100", "SAVE150", "SAVE200", "SAVE10P", "SAVE20P"]) await assert.rejects(() => t.svc.createOffer(t.user, t.order.id, { couponCode: old }), (e: any) => e.statusCode === 400 && /not an active Fastrr coupon/.test(e.message), old);
      await assert.rejects(() => t.svc.createOffer(t.user, t.order.id, { couponCode: "FASTRR100", discountType: "FIXED", discountValue: "1" }), (e: any) => e.statusCode === 400 && /not both/.test(e.message));
      await assert.rejects(() => t.svc.createOffer(t.user, t.order.id, { couponCode: "FASTRR100", expectedPrepaidAmount: "500.00" }), (e: any) => e.statusCode === 409);
      await assert.rejects(() => t.svc.createOffer(t.user, t.order.id, { discountType: "FIXED", discountValue: "1249" }), (e: any) => e.statusCode === 400, "strict: must leave something to pay");
      await assert.rejects(() => t.svc.createOffer(t.user, t.order.id, {}), (e: any) => e.statusCode === 400);
      useFastrr([]);
      await assert.rejects(() => t.svc.createOffer(t.user, t.order.id, { couponCode: "FASTRR100" }), (e: any) => e.statusCode === 400, "no longer active in Fastrr");
      assert.equal((await t.svc.getUpgrade(t.user, t.order.id)).offer, null);
    });
  });
});
