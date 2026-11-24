// Coupon pricing on real tables, through the REAL order service (Shopify / Cashfree / WhatsApp are fakes). Run on the ISOLATED database only; every test is one rolled-back transaction.
// The business example: product Rs 1,000, coupon NEWYEAR_OFFER = 50%.
//   prepaid: 1,000 - 500 = 500 (no COD fee)        COD: 1,000 - 500 + 49 COD fee = 549 (the fee is added AFTER the coupon and is never discounted)
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "../orders/orders.service.js";
import { writeShopifySyncSetting } from "../settings/shopify-sync.setting.js";
import CouponsService, { type CouponInput } from "./coupons.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const ADDRESS = { name: "Priya Shah", line1: "12 MG Road", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India", phone: "9876500000" };

async function world(tx: Prisma.TransactionClient) {
  const shopify = { query: async () => ({ order: { id: "gid://shopify/Order/1", tags: [] }, orders: { nodes: [] } }) } as unknown as ShopifyClient;
  const noMessages = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;
  const cashfree = (() => ({ createPaymentLink: async () => ({ reused: false, paymentId: uid(), paymentUrl: "https://pay.test/x", expiresAt: null }) })) as never;
  const orders = new OrdersService(tx as never, () => shopify, cashfree, noMessages);
  const coupons = new CouponsService(tx);
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN }, select: { id: true } });
  await writeShopifySyncSetting(tx as never, false, admin.id);
  const tele = await tx.user.create({ data: { name: "Tele", username: `t-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true, role: true } });
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "1000.00" }, select: { id: true } });
  const lead = async (customerType: "REGULAR" | "DISTRIBUTOR" = "REGULAR") => tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", mobile: "9876500000", normalizedMobile: "+919876500000", ownerId: tele.id, customerType }, select: { id: true } });
  const order = (leadId: string, mode: "COD" | "PAYMENT_LINK", discount: unknown, extra: Record<string, unknown> = {}) =>
    orders.createManualOrder({ id: tele.id, username: tele.username, role: tele.role } as never, { leadId, items: [{ productId: product.id, quantity: 1, unitPrice: "1000.00" }], paymentMethod: mode, shippingAddress: ADDRESS, shippingPincode: "411001", shippingAmount: "999", idempotencyKey: `k-${uid()}`, ...(discount === undefined ? {} : { discount }), ...extra } as never);
  const coupon = (over: Partial<CouponInput> & { code: string }) => coupons.create(admin.id, { discountType: "PERCENT", discountValue: "50", eligibility: "ALL", ...over });
  return { tx, coupons, order, lead, coupon };
}
const row = (tx: Prisma.TransactionClient, id: string) => tx.order.findUniqueOrThrow({ where: { id }, select: { subtotal: true, discountAmount: true, shippingAmount: true, totalAmount: true, couponId: true, couponCode: true, metadata: true } });
const figures = (r: Awaited<ReturnType<typeof row>>) => ({ subtotal: r.subtotal.toString(), discount: r.discountAmount.toString(), shipping: r.shippingAmount.toString(), total: r.totalAmount.toString() });

describe("the business example: Rs 1,000 with NEWYEAR_OFFER (50%)", () => {
  it("PREPAID: 1,000 - 500 = 500, no COD fee", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.coupon({ code: "NEWYEAR_OFFER" });
      const r = await w.order((await w.lead()).id, "PAYMENT_LINK", { couponCode: "NEWYEAR_OFFER" });
      const f = figures(await row(tx, r.order.id));
      assert.deepEqual(f, { subtotal: "1000", discount: "500", shipping: "0", total: "500" });
    });
  });

  it("COD: 1,000 - 500 = 500 discounted amount + 49 COD fee = 549 (the fee is not discounted)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.coupon({ code: "NEWYEAR_OFFER" });
      const r = await w.order((await w.lead()).id, "COD", { couponCode: "NEWYEAR_OFFER" });
      const f = figures(await row(tx, r.order.id));
      assert.deepEqual(f, { subtotal: "1000", discount: "500", shipping: "49", total: "549" });
      // the request carried shippingAmount 999: the browser's figure is ignored, the server charges the flat COD fee
    });
  });

  it("the order keeps the coupon code, type, value and the actual discount, and is not changed when the coupon is edited, deactivated or deleted later", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const c = await w.coupon({ code: "NEWYEAR_OFFER" });
      const r = await w.order((await w.lead()).id, "COD", { couponCode: "NEWYEAR_OFFER" });
      const before = await row(tx, r.order.id);
      assert.equal(before.couponCode, "NEWYEAR_OFFER");
      assert.equal(before.couponId, c.id);
      const d = (before.metadata as { discount: Record<string, unknown> }).discount;
      assert.deepEqual([d.couponCode, d.discountType, d.discountValue, d.discountAmount, d.finalTotal, d.originalSubtotal], ["NEWYEAR_OFFER", "PERCENT", "50", "500.00", "549.00", "1000.00"]);
      await w.coupons.update(c.id, { code: "NEWYEAR_OFFER", discountType: "PERCENT", discountValue: "10", eligibility: "ALL" });
      await w.coupons.setActive(c.id, false);
      await w.coupons.remove(c.id);
      const after = await row(tx, r.order.id);
      assert.deepEqual(figures(after), figures(before));
      assert.deepEqual(after.metadata, before.metadata);
      assert.equal(after.couponCode, "NEWYEAR_OFFER");
    });
  });
});

describe("percentage and flat coupons, prepaid and COD", () => {
  it("flat Rs 100: prepaid 900, COD 949", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.coupon({ code: "FLAT100", discountType: "FIXED", discountValue: "100" });
      const l = await w.lead();
      assert.equal(figures(await row(tx, (await w.order(l.id, "PAYMENT_LINK", { couponCode: "FLAT100" })).order.id)).total, "900");
      assert.equal(figures(await row(tx, (await w.order(l.id, "COD", { couponCode: "FLAT100" })).order.id)).total, "949");
    });
  });

  it("maximum discount: 50% capped at Rs 300 gives prepaid 700 and COD 749", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.coupon({ code: "CAPPED", maxDiscount: "300" });
      const l = await w.lead();
      assert.deepEqual(figures(await row(tx, (await w.order(l.id, "PAYMENT_LINK", { couponCode: "CAPPED" })).order.id)), { subtotal: "1000", discount: "300", shipping: "0", total: "700" });
      assert.deepEqual(figures(await row(tx, (await w.order(l.id, "COD", { couponCode: "CAPPED" })).order.id)), { subtotal: "1000", discount: "300", shipping: "49", total: "749" });
    });
  });

  it("an order without a coupon: COD adds only the 49 fee, prepaid is the plain price", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead();
      assert.equal(figures(await row(tx, (await w.order(l.id, "COD", { none: true })).order.id)).total, "1049");
      assert.equal(figures(await row(tx, (await w.order(l.id, "PAYMENT_LINK", { none: true })).order.id)).total, "1000");
    });
  });
});

describe("the backend rejects coupons that must not apply (the order is not created)", () => {
  const refused = async (w: Awaited<ReturnType<typeof world>>, code: string, mode: "COD" | "PAYMENT_LINK" = "COD", leadType: "REGULAR" | "DISTRIBUTOR" = "REGULAR") => {
    const l = await w.lead(leadType);
    const before = await w.tx.order.count();
    await assert.rejects(w.order(l.id, mode, { couponCode: code }), (e: any) => e.statusCode === 400);
    assert.equal(await w.tx.order.count(), before, "no order is created");
  };

  it("inactive, unknown and deleted coupons", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const c = await w.coupon({ code: "OFFNOW" });
      await w.coupons.setActive(c.id, false);
      await refused(w, "OFFNOW");
      await refused(w, "NO_SUCH_CODE");
      const d = await w.coupon({ code: "GONE" });
      await w.coupons.remove(d.id);
      await refused(w, "GONE");
    });
  });

  it("a minimum order value above the order amount", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.coupon({ code: "BIGSPEND", minOrderValue: "1500" });
      await refused(w, "BIGSPEND");
      await refused(w, "BIGSPEND", "PAYMENT_LINK");
      await w.coupon({ code: "JUSTENOUGH", minOrderValue: "1000" });
      const l = await w.lead();
      assert.equal(figures(await row(w.tx, (await w.order(l.id, "PAYMENT_LINK", { couponCode: "JUSTENOUGH" })).order.id)).total, "500");
    });
  });

  it("an ineligible customer (a distributor-only coupon for a regular customer)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.coupon({ code: "DISTONLY", eligibility: "DISTRIBUTOR" });
      await refused(w, "DISTONLY", "COD", "REGULAR");
      const l = await w.lead("DISTRIBUTOR");
      assert.equal(figures(await row(w.tx, (await w.order(l.id, "PAYMENT_LINK", { couponCode: "DISTONLY" })).order.id)).total, "500");
    });
  });

  it("a flat coupon larger than the order, and a total the browser calculated differently (409)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.coupon({ code: "HUGE", discountType: "FIXED", discountValue: "5000" });
      await refused(w, "HUGE");
      await w.coupon({ code: "NEWYEAR_OFFER" });
      const l = await w.lead();
      // the browser claims the COD total is 500 (the coupon applied to the fee too, or no fee): the server's 549 wins and the order is refused
      await assert.rejects(w.order(l.id, "COD", { couponCode: "NEWYEAR_OFFER" }, { expectedTotal: "500" }), (e: any) => e.statusCode === 409);
      const ok = await w.order(l.id, "COD", { couponCode: "NEWYEAR_OFFER" }, { expectedTotal: "549" });
      assert.equal(figures(await row(w.tx, ok.order.id)).total, "549");
    });
  });
});

describe("Admin coupon management and what the telecaller is offered", () => {
  it("codes are unique ignoring case and spacing; invalid values give a clear message", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.coupon({ code: "NEWYEAR_OFFER" });
      await assert.rejects(w.coupon({ code: " newyear_offer " }), (e: any) => e.statusCode === 409 && /already exists/.test(e.message));
      await assert.rejects(w.coupon({ code: "BAD", discountValue: "150" }), (e: any) => e.statusCode === 400 && /cannot exceed 100%/.test(e.message));
      await assert.rejects(w.coupon({ code: "BADFLAT", discountType: "FIXED", discountValue: "0" }), (e: any) => e.statusCode === 400 && /greater than 0/.test(e.message));
      await assert.rejects(w.coupon({ code: "BADMAX", discountType: "FIXED", discountValue: "10", maxDiscount: "5" }), (e: any) => e.statusCode === 400 && /percentage coupons/.test(e.message));
      await assert.rejects(w.coupon({ code: "x" }), (e: any) => e.statusCode === 400 && /3-50 characters/.test(e.message));
    });
  });

  it("an active coupon is offered to the telecaller straight away; deactivating it removes it; an ineligible one is shown as such with the reason", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const names = async (type: "REGULAR" | "DISTRIBUTOR") => (await w.coupons.availableFor(type)).map((c) => `${c.code}:${c.eligible}`);
      const baseline = await names("REGULAR");
      const c = await w.coupon({ code: "NEWYEAR_OFFER" });
      await w.coupon({ code: "DISTONLY", eligibility: "DISTRIBUTOR" });
      assert.ok((await names("REGULAR")).includes("NEWYEAR_OFFER:true"));
      assert.ok((await names("REGULAR")).includes("DISTONLY:false"));
      assert.ok((await names("DISTRIBUTOR")).includes("DISTONLY:true"));
      const offered = (await w.coupons.availableFor("REGULAR")).find((x) => x.code === "NEWYEAR_OFFER")!;
      assert.deepEqual([offered.type, offered.value, offered.eligible, offered.reason], ["PERCENT", "50", true, null]);
      assert.match((await w.coupons.availableFor("REGULAR")).find((x) => x.code === "DISTONLY")!.reason ?? "", /Only for distributors/);
      await w.coupons.setActive(c.id, false);
      assert.ok(!(await names("REGULAR")).some((n) => n.startsWith("NEWYEAR_OFFER")));
      assert.ok(baseline.length >= 0);
    });
  });
});
