// Database integration tests for CRM coupons. Run with: npm run test:db  (ISOLATED database only)
// Every test runs inside ONE transaction that is always rolled back. Shopify, Cashfree, WhatsApp are fakes; nothing external is contacted.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "../orders/orders.service.js";
import DiscountsService from "../discounts/discounts.service.js";
import { writeShopifySyncSetting } from "../settings/shopify-sync.setting.js";
import CouponsService from "./coupons.service.js";

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
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN }, select: { id: true, username: true, role: true } });
  await writeShopifySyncSetting(tx as never, false, admin.id); // no Shopify call in these tests
  const tele = await tx.user.create({ data: { name: "Tele", username: `t-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true, role: true } });
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "1199.00" }, select: { id: true } });
  const lead = async (customerType: "REGULAR" | "DISTRIBUTOR") => tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", mobile: "9876500000", normalizedMobile: "+919876500000", ownerId: tele.id, customerType }, select: { id: true } });
  const create = (leadId: string, discount: unknown, extra: Record<string, unknown> = {}) =>
    orders.createManualOrder({ id: tele.id, username: tele.username, role: tele.role } as never, { leadId, items: [{ productId: product.id, quantity: 1, unitPrice: "1199.00" }], paymentMethod: "COD", shippingAddress: ADDRESS, shippingPincode: "411001", shippingAmount: "50", idempotencyKey: `k-${uid()}`, ...(discount === undefined ? {} : { discount }), ...extra } as never);
  return { tx, orders, coupons, admin, tele, lead, create };
}
const NEW = { code: "SAVE100", discountType: "FIXED" as const, discountValue: "100", eligibility: "ALL" as const };
const orderRow = (tx: Prisma.TransactionClient, id: string) => tx.order.findUniqueOrThrow({ where: { id }, select: { discountAmount: true, totalAmount: true, subtotal: true, couponId: true, couponCode: true, discountReason: true, metadata: true } });

describe("DISTRIBUTOR500, the default coupon", () => {
  it("exists after the migration: fixed Rs 500, distributors only, active", async () => {
    await inRollback(async (tx) => {
      const c = await tx.coupon.findFirstOrThrow({ where: { code: "DISTRIBUTOR500", deletedAt: null } });
      assert.deepEqual([c.discountType, c.discountValue.toString(), c.eligibleCustomerType, c.isActive, c.minOrderValue, c.maxDiscount], ["FIXED", "500", "DISTRIBUTOR", true, null, null]);
    });
  });

  it("gives exactly Rs 500 off a distributor's order, and the order keeps the coupon, type, amount and final total", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("DISTRIBUTOR");
      const r = await w.create(l.id, { couponCode: "DISTRIBUTOR500" });
      const row = await orderRow(tx, r.order.id);
      assert.equal(row.discountAmount.toString(), "500");
      assert.equal(row.subtotal.toString(), "1199");
      assert.equal(row.totalAmount.toString(), "749", "1199 - 500 + 50 shipping");
      assert.equal(row.couponCode, "DISTRIBUTOR500");
      assert.ok(row.couponId);
      assert.match(row.discountReason ?? "", /Coupon DISTRIBUTOR500/);
      const d = (row.metadata as { discount: Record<string, unknown> }).discount;
      assert.deepEqual([d.couponCode, d.couponSource, d.discountType, d.discountAmount, d.finalTotal], ["DISTRIBUTOR500", "CRM", "FIXED", "500.00", "749.00"]);
    });
  });

  it("a non-distributor can not use it: refused by the backend, no order is created", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("REGULAR");
      await assert.rejects(w.create(l.id, { couponCode: "DISTRIBUTOR500" }), (e: any) => e.statusCode === 400 && /Only for distributors/.test(e.message));
      assert.equal(await tx.order.count({ where: { leadId: l.id } }), 0);
    });
  });

  it("is not stacked: a coupon together with a custom discount is refused", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("DISTRIBUTOR");
      await assert.rejects(w.create(l.id, { couponCode: "DISTRIBUTOR500", type: "FIXED", value: "10" }), (e: any) => e.statusCode === 400);
      await assert.rejects(w.create(l.id, { couponCode: "DISTRIBUTOR500" }, { discountPercent: "10" }), (e: any) => e.statusCode === 400);
      assert.equal(await tx.order.count({ where: { leadId: l.id } }), 0);
    });
  });

  it("never exceeds the subtotal", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("DISTRIBUTOR");
      await w.coupons.create(w.admin.id, { ...NEW, code: "BIG", discountValue: "5000" });
      await assert.rejects(w.create(l.id, { couponCode: "BIG" }), (e: any) => e.statusCode === 400 && /more than the order amount/.test(e.message));
    });
  });
});

describe("what a telecaller sees in Edit Discount", () => {
  it("a distributor's order: DISTRIBUTOR500 is offered and eligible; a regular customer sees it disabled with the reason", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const dist = (await new DiscountsService(tx).options("ORDER", "DISTRIBUTOR")) as { coupons: { code: string; eligible: boolean; reason: string | null }[] };
      const reg = (await new DiscountsService(tx).options("ORDER", "REGULAR")) as typeof dist;
      assert.equal(dist.coupons.find((c) => c.code === "DISTRIBUTOR500")?.eligible, true);
      const hidden = reg.coupons.find((c) => c.code === "DISTRIBUTOR500")!;
      assert.equal(hidden.eligible, false);
      assert.match(hidden.reason ?? "", /Only for distributors/);
      // an all-customers coupon is eligible for both; an inactive one is not listed at all
      await w.coupons.create(w.admin.id, NEW);
      const off = await w.coupons.create(w.admin.id, { ...NEW, code: "OFFLINE" });
      await w.coupons.setActive(off.id, false);
      const after = (await new DiscountsService(tx).options("ORDER", "REGULAR")) as typeof dist;
      assert.equal(after.coupons.find((c) => c.code === "SAVE100")?.eligible, true);
      assert.equal(after.coupons.some((c) => c.code === "OFFLINE"), false);
    });
  });

  it("does not depend on Fastrr: the coupons are there although Fastrr is not configured", async () => {
    await inRollback(async (tx) => {
      const o = (await new DiscountsService(tx).options("ORDER", "DISTRIBUTOR")) as { coupons: unknown[]; fastrr: { reason: string | null } };
      assert.ok(o.coupons.length >= 1);
      assert.ok(o.fastrr, "the Fastrr part is only informational");
    });
  });
});

describe("the backend rejects what must not apply", () => {
  it("an inactive coupon, then active again", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("REGULAR");
      const c = await w.coupons.create(w.admin.id, NEW);
      await w.coupons.setActive(c.id, false);
      await assert.rejects(w.create(l.id, { couponCode: "SAVE100" }), (e: any) => e.statusCode === 400 && /not active/.test(e.message));
      await w.coupons.setActive(c.id, true);
      const r = await w.create(l.id, { couponCode: "save100" }); // codes are not case sensitive
      assert.equal((await orderRow(tx, r.order.id)).discountAmount.toString(), "100");
    });
  });

  it("a deleted or unknown coupon", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("REGULAR");
      const c = await w.coupons.create(w.admin.id, NEW);
      await w.coupons.remove(c.id);
      await assert.rejects(w.create(l.id, { couponCode: "SAVE100" }), (e: any) => e.statusCode === 400 && /not valid/.test(e.message));
      await assert.rejects(w.create(l.id, { couponCode: "NOSUCH" }), (e: any) => e.statusCode === 400);
    });
  });

  it("minimum order value, and a percentage coupon with a maximum", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("REGULAR");
      await w.coupons.create(w.admin.id, { ...NEW, code: "MIN2000", discountValue: "100", minOrderValue: "2000" });
      await assert.rejects(w.create(l.id, { couponCode: "MIN2000" }), (e: any) => /minimum order/.test(e.message));
      await w.coupons.create(w.admin.id, { code: "TEN", discountType: "PERCENT", discountValue: "10", eligibility: "ALL", maxDiscount: "100" });
      const r = await w.create(l.id, { couponCode: "TEN" });
      assert.equal((await orderRow(tx, r.order.id)).discountAmount.toString(), "100", "10% of 1199 is 119.90, capped at the maximum");
    });
  });
});

describe("existing discounts are unchanged", () => {
  it("a custom discount (fixed and percentage) and no discount still work, with no coupon recorded", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("REGULAR");
      const fixed = await orderRow(tx, (await w.create(l.id, { type: "FIXED", value: "75" })).order.id);
      assert.deepEqual([fixed.discountAmount.toString(), fixed.totalAmount.toString(), fixed.couponId, fixed.couponCode], ["75", "1174", null, null]);
      const pct = await orderRow(tx, (await w.create(l.id, { type: "PERCENT", value: "10" })).order.id);
      assert.equal(pct.discountAmount.toString(), "119.9");
      const none = await orderRow(tx, (await w.create(l.id, { none: true })).order.id);
      assert.equal(none.discountAmount.toString(), "0");
      const legacy = await orderRow(tx, (await w.create(l.id, undefined, { discountAmount: "20" })).order.id);
      assert.equal(legacy.discountAmount.toString(), "20");
    });
  });
});

describe("Admin manages coupons", () => {
  it("create, edit, toggle and delete; duplicate codes are refused", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const c = await w.coupons.create(w.admin.id, { ...NEW, minOrderValue: "500" });
      assert.deepEqual([c.code, c.discountType, c.discountValue, c.eligibility, c.minOrderValue, c.isActive], ["SAVE100", "FIXED", "100", "ALL", "500", true]);
      await assert.rejects(w.coupons.create(w.admin.id, NEW), (e: any) => e.statusCode === 409);

      const edited = await w.coupons.update(c.id, { code: "SAVE15", discountType: "PERCENT", discountValue: "15", eligibility: "DISTRIBUTOR", maxDiscount: "300" });
      assert.deepEqual([edited.code, edited.discountType, edited.discountValue, edited.eligibility, edited.minOrderValue, edited.maxDiscount], ["SAVE15", "PERCENT", "15", "DISTRIBUTOR", null, "300"]);
      assert.equal((await w.coupons.setActive(c.id, false)).isActive, false);
      assert.ok((await w.coupons.list()).some((x) => x.code === "SAVE15" && !x.isActive));

      assert.deepEqual(await w.coupons.remove(c.id), { deleted: "hard" }, "never used: removed");
      assert.ok(!(await w.coupons.list()).some((x) => x.code === "SAVE15"));
      await assert.rejects(w.coupons.update(c.id, NEW), (e: any) => e.statusCode === 404);
    });
  });

  it("deleting a coupon an order used is a soft delete: the order keeps its discount record, and the code can be created again", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("REGULAR");
      const c = await w.coupons.create(w.admin.id, NEW);
      const r = await w.create(l.id, { couponCode: "SAVE100" });
      assert.equal((await w.coupons.list()).find((x) => x.id === c.id)?.usedByOrders, 1);

      assert.deepEqual(await w.coupons.remove(c.id), { deleted: "soft" });
      const gone = await tx.coupon.findUniqueOrThrow({ where: { id: c.id } });
      assert.ok(gone.deletedAt && gone.isActive === false);
      assert.ok(!(await w.coupons.list()).some((x) => x.id === c.id));

      const row = await orderRow(tx, r.order.id);
      assert.deepEqual([row.couponId, row.couponCode, row.discountAmount.toString(), row.totalAmount.toString()], [c.id, "SAVE100", "100", "1149"]);
      assert.equal((row.metadata as { discount: { couponCode: string } }).discount.couponCode, "SAVE100");

      const again = await w.coupons.create(w.admin.id, { ...NEW, discountValue: "30" });
      assert.notEqual(again.id, c.id);
      assert.equal((await orderRow(tx, r.order.id)).discountAmount.toString(), "100", "the old order is untouched by the new coupon");
    });
  });

  it("deactivating a coupon later does not change an order that used it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("REGULAR");
      const c = await w.coupons.create(w.admin.id, NEW);
      const r = await w.create(l.id, { couponCode: "SAVE100" });
      await w.coupons.setActive(c.id, false);
      await w.coupons.update(c.id, { ...NEW, discountValue: "999" });
      const row = await orderRow(tx, r.order.id);
      assert.deepEqual([row.discountAmount.toString(), row.couponCode, row.totalAmount.toString()], ["100", "SAVE100", "1149"]);
    });
  });

  it("marking a customer as a distributor is what makes DISTRIBUTOR500 usable, within the caller's scope", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("REGULAR");
      await assert.rejects(w.create(l.id, { couponCode: "DISTRIBUTOR500" }), (e: any) => e.statusCode === 400);
      await assert.rejects(w.coupons.setCustomerType(l.id, "DISTRIBUTOR", { ownerId: uid() }), (e: any) => e.statusCode === 404, "out of scope");
      await w.coupons.setCustomerType(l.id, "DISTRIBUTOR", {});
      const r = await w.create(l.id, { couponCode: "DISTRIBUTOR500" });
      assert.equal((await orderRow(tx, r.order.id)).discountAmount.toString(), "500");
      await assert.rejects(w.coupons.setCustomerType(l.id, "VIP" as never, {}), (e: any) => e.statusCode === 400);
    });
  });
});
