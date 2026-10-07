// Discounts: the configured custom default, Fastrr coupons (stubbed Fastrr source), resolution + validation, Create Order persistence.
// The CRM has no coupon table. Every DB test runs in ONE transaction that is always rolled back.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "../orders/orders.service.js";
import DiscountsService, { computeDiscountCents, setDefaultOffersSource } from "./discounts.service.js";
import { loadDefaultDiscount } from "./discounts.config.js";
import type { ActiveOffer } from "../offers/offers.types.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(async () => {
  setDefaultOffersSource(null);
  await prisma.$disconnect();
});

const uid = () => randomUUID();
const offer = (o: Partial<ActiveOffer>): ActiveOffer => ({ id: `fr-${uid().slice(0, 6)}`, couponCode: "FASTRR100", discountType: "flat", discountValue: 100, automaticDiscount: false, startTime: null, endTime: null, active: true, minCartTotal: null, minQtyProduct: null, productFilter: null, expiringSoon: false, ...o });
const ALL = [
  offer({ id: "fr-1", couponCode: "FASTRR100" }),
  offer({ id: "fr-2", couponCode: "FASTRR10P", discountType: "percentage", discountValue: 10 }),
  offer({ id: "fr-3", couponCode: null }),
  offer({ id: "fr-4", couponCode: "AUTO", automaticDiscount: true }),
  offer({ id: "fr-5", couponCode: "FREE", discountType: "freebie", discountValue: null }),
  offer({ id: "fr-6", couponCode: "FILT", productFilter: { ids: [1] } }),
  offer({ id: "fr-7", couponCode: "MIN1000", minCartTotal: 1000 }),
];
const stub = (offers: ActiveOffer[] | Error = ALL) => ({
  getActiveOffers: async () => {
    if (offers instanceof Error) throw offers;
    return { offers, fetchedAt: new Date().toISOString() };
  },
});
let shopifyN = 0;
const fakeShopify = () => ({ query: async () => ({ orderCreate: { order: { id: `gid://shopify/Order/${uid()}`, name: `#T${++shopifyN}` }, userErrors: [] } }) }) as unknown as ShopifyClient;
const fakeNotify = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;
const OLD_CODES = ["SAVE50", "SAVE100", "SAVE150", "SAVE200", "SAVE10P", "SAVE20P"];

describe("options: custom ₹50 default + live Fastrr coupons only", () => {
  it("the default is a CUSTOM FIXED 50 from configuration; no SAVE* coupon exists anywhere in the options", async () => {
    const o = await new DiscountsService(prisma as never, stub()).options("ORDER");
    assert.deepEqual(o.defaultDiscount, { type: "FIXED", value: "50" });
    const json = JSON.stringify(o);
    for (const old of OLD_CODES) assert.ok(!json.includes(old), old);
    assert.equal("defaultCouponId" in o, false);
  });
  it("Fastrr coupons appear only when usable: has a code, not automatic, flat/percentage, no unverifiable filter; values come from Fastrr", async () => {
    const o = await new DiscountsService(prisma as never, stub()).options("UPGRADE");
    assert.equal(o.fastrr.available, true);
    assert.deepEqual(o.fastrr.coupons.map((c) => [c.code, c.type, c.value]), [["FASTRR100", "FIXED", "100"], ["FASTRR10P", "PERCENT", "10"], ["MIN1000", "FIXED", "100"]]);
  });
  it("when Fastrr is not configured/unreachable: unavailable with the reason, and NO invented coupons", async () => {
    const o = await new DiscountsService(prisma as never, stub(new Error("Fastrr offers are not configured: FASTRR_API_TOKEN is not set"))).options("ORDER");
    assert.deepEqual([o.fastrr.available, o.fastrr.coupons.length], [false, 0]);
    assert.match(o.fastrr.reason!, /FASTRR_API_TOKEN/);
    assert.deepEqual(o.defaultDiscount, { type: "FIXED", value: "50" }, "the custom default still works without Fastrr");
  });
  it("DEFAULT_DISCOUNT_* changes the default without code changes; junk falls back to FIXED 50", () => {
    assert.deepEqual(loadDefaultDiscount({ DEFAULT_DISCOUNT_TYPE: "percent", DEFAULT_DISCOUNT_VALUE: "10" }), { type: "PERCENT", value: "10" });
    assert.deepEqual(loadDefaultDiscount({ DEFAULT_DISCOUNT_TYPE: "PERCENT", DEFAULT_DISCOUNT_VALUE: "150" }), { type: "FIXED", value: "50" });
    assert.deepEqual(loadDefaultDiscount({}), { type: "FIXED", value: "50" });
  });
  it("the discount_coupons table no longer exists", async () => {
    const rows = await prisma.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('public.discount_coupons')::text AS t`;
    assert.equal(rows[0]?.t, null);
  });
});

describe("resolve + validation (the server decides the discount)", () => {
  it("pure maths: fixed and percentage in whole paise on a 499 subtotal", () => {
    assert.deepEqual(computeDiscountCents(49900, "FIXED", "50"), { cents: 5000, value: "50.00" });
    assert.deepEqual(computeDiscountCents(49900, "PERCENT", "10"), { cents: 4990, value: "10.00" });
    assert.equal(computeDiscountCents(49900, "FIXED", "499").cents, 49900);
  });
  it("custom fixed (default 50 and 100), custom percentage, Fastrr coupon and none resolve correctly; the choice REPLACES the default", async () => {
    const svc = new DiscountsService(prisma as never, stub());
    const base = 49900;
    const def = await svc.resolve("ORDER", { type: "FIXED", value: "50" }, base);
    assert.deepEqual([def.amountCents, def.source, def.couponCode, def.couponSource, def.wasDefault], [5000, "CUSTOM", null, null, true]);
    const hundred = await svc.resolve("ORDER", { type: "FIXED", value: "100" }, base);
    assert.deepEqual([hundred.amountCents, hundred.wasDefault], [10000, false], "100 replaces 50 - it is not 150");
    assert.equal((await svc.resolve("ORDER", { type: "PERCENT", value: 10 }, base)).amountCents, 4990);
    const c = await svc.resolve("ORDER", { couponCode: "FASTRR100" }, base);
    assert.deepEqual([c.amountCents, c.source, c.couponSource, c.couponCode, c.couponId], [10000, "FASTRR", "FASTRR", "FASTRR100", "fr-1"]);
    assert.equal((await svc.resolve("ORDER", { couponCode: "FASTRR10P" }, base)).amountCents, 4990);
    assert.equal((await svc.resolve("ORDER", { none: true }, base)).amountCents, 0);
    assert.equal((await svc.resolve("ORDER", undefined, base)).source, "NONE");
  });
  it("rejects negative, >100%, over-the-amount, malformed, old CRM / unknown coupons, unusable Fastrr offers and tampered requests", async () => {
    const svc = new DiscountsService(prisma as never, stub());
    const rej = async (sel: object, re: RegExp) => assert.rejects(() => svc.resolve("ORDER", sel as never, 49900), (e: any) => e.statusCode === 400 && re.test(e.message), JSON.stringify(sel));
    await rej({ type: "FIXED", value: "-5" }, /negative/);
    await rej({ type: "PERCENT", value: "101" }, /cannot exceed 100%/);
    await rej({ type: "FIXED", value: "500" }, /cannot exceed the amount/);
    await rej({ type: "FIXED", value: "abc" }, /valid discount amount/);
    await rej({ type: "PERCENT", value: "abc" }, /valid discount percentage/);
    await rej({ value: "10" }, /discount type/);
    for (const old of OLD_CODES) await rej({ couponCode: old }, /not an active Fastrr coupon/);
    await rej({ couponCode: "NOPE" }, /not an active Fastrr coupon/);
    await rej({ couponCode: "AUTO" }, /can not be applied/);
    await rej({ couponCode: "FREE" }, /can not be applied/);
    await rej({ couponCode: "FILT" }, /can not be applied/);
    await rej({ couponCode: "MIN1000" }, /minimum order/);
    await rej({ couponCode: "" }, /Choose a Fastrr coupon/);
    await rej({ couponCode: "FASTRR100", type: "FIXED", value: "1" }, /not both/);
    await rej({ couponCode: "FASTRR100", value: "1" }, /not both/);
    const gone = new DiscountsService(prisma as never, stub([]));
    await assert.rejects(() => gone.resolve("ORDER", { couponCode: "FASTRR100" }, 49900), (e: any) => e.statusCode === 400, "expired / deactivated in Fastrr");
    const down = new DiscountsService(prisma as never, stub(new Error("x")));
    await assert.rejects(() => down.resolve("ORDER", { couponCode: "FASTRR100" }, 49900), (e: any) => e.statusCode === 503, "can't validate -> refuse, never guess");
    assert.equal((await down.resolve("ORDER", { type: "FIXED", value: "50" }, 49900)).amountCents, 5000, "custom still works when Fastrr is down");
  });
});

describe("Create Order: default, edit, Fastrr coupon, custom, persistence, tamper-proofing", () => {
  async function setup(tx: Prisma.TransactionClient) {
    const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
    const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", mobile: "9000000123", normalizedMobile: "+919000000123" }, select: { id: true } });
    const product = await tx.product.create({ data: { name: "Herbal Tea", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "499.00" }, select: { id: true } });
    setDefaultOffersSource(stub());
    const svc = new OrdersService(tx as never, () => fakeShopify(), undefined, fakeNotify);
    const create = (extra: Record<string, unknown>) => svc.createManualOrder({ id: admin.id, username: admin.username, role: Role.ADMIN }, { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "499.00" }], paymentMethod: "COD", ...extra } as never);
    return { create };
  }
  const meta = async (tx: Prisma.TransactionClient, orderId: string) => ((await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true } })).metadata as any).discount;
  const FIFTY = { type: "FIXED", value: "50" };

  it("default custom ₹50: 499 - 50 = 449, persisted as a CUSTOM discount (no coupon) with original subtotal and final total", async () => {
    await inRollback(async (tx) => {
      const { create } = await setup(tx);
      const r = await create({ discount: FIFTY });
      assert.deepEqual([Number(r.order.subtotal), Number(r.order.discountAmount), Number(r.order.totalAmount)], [499, 50, 449]);
      const d = await meta(tx, r.order.id);
      assert.deepEqual([d.originalSubtotal, d.discountType, d.discountValue, d.discountAmount, d.couponId, d.couponCode, d.couponSource, d.source, d.wasDefault, d.finalTotal], ["499.00", "FIXED", "50.00", "50.00", null, null, null, "CUSTOM", true, "449.00"]);
      assert.equal(r.order.discountReason, "Custom discount");
    });
  });
  it("Edit 50 -> 100 gives 399 (replaces, never 349); 10% gives 449.10; a Fastrr coupon is persisted with its source; none removes it", async () => {
    await inRollback(async (tx) => {
      const { create } = await setup(tx);
      const a = await create({ discount: { type: "FIXED", value: "100" } });
      assert.deepEqual([Number(a.order.discountAmount), Number(a.order.totalAmount)], [100, 399]);
      const b = await create({ discount: { type: "PERCENT", value: "10" } });
      assert.deepEqual([Number(b.order.discountAmount), Number(b.order.totalAmount)], [49.9, 449.1]);
      const e = await create({ discount: { type: "PERCENT", value: "20" } });
      assert.equal(Number(e.order.totalAmount), 399.2);
      const f = await create({ discount: { couponCode: "FASTRR100" } });
      assert.deepEqual([Number(f.order.totalAmount), f.order.discountReason], [399, "Fastrr coupon FASTRR100"]);
      const fd = await meta(tx, f.order.id);
      assert.deepEqual([fd.source, fd.couponSource, fd.couponCode, fd.couponId, fd.discountType, fd.discountValue, fd.discountAmount, fd.finalTotal], ["FASTRR", "FASTRR", "FASTRR100", "fr-1", "FIXED", "100.00", "100.00", "399.00"]);
      const none = await create({ discount: { none: true } });
      assert.deepEqual([Number(none.order.discountAmount), Number(none.order.totalAmount)], [0, 499]);
    });
  });
  it("shipping is added after the discount; a legacy request with no discount field is unchanged (no implicit default)", async () => {
    await inRollback(async (tx) => {
      const { create } = await setup(tx);
      const a = await create({ discount: FIFTY, shippingAmount: "40.00" });
      assert.equal(Number(a.order.totalAmount), 489);
      const legacy = await create({});
      assert.deepEqual([Number(legacy.order.discountAmount), Number(legacy.order.totalAmount)], [0, 499]);
    });
  });
  it("tamper-proof: a different total is refused with nothing created; old CRM coupon codes/ids and bad values are refused", async () => {
    await inRollback(async (tx) => {
      const { create } = await setup(tx);
      const before = await tx.order.count();
      await assert.rejects(() => create({ discount: FIFTY, expectedTotal: "300.00" }), (e: any) => e.statusCode === 409);
      for (const old of OLD_CODES) await assert.rejects(() => create({ discount: { couponCode: old } }), (e: any) => e.statusCode === 400, old);
      await assert.rejects(() => create({ discount: { couponCode: "NOPE" } }), (e: any) => e.statusCode === 400);
      await assert.rejects(() => create({ discount: { type: "FIXED", value: "600" } }), (e: any) => e.statusCode === 400);
      await assert.rejects(() => create({ discount: { type: "PERCENT", value: "150" } }), (e: any) => e.statusCode === 400);
      await assert.rejects(() => create({ discount: { type: "FIXED", value: "-1" } }), (e: any) => e.statusCode === 400);
      await assert.rejects(() => create({ discount: FIFTY, discountPercent: "5" }), (e: any) => e.statusCode === 400, "one discount only");
      assert.equal(await tx.order.count(), before, "a refused discount never leaves an order behind");
      const ok = await create({ discount: FIFTY, expectedTotal: "449.00" });
      assert.equal(Number(ok.order.totalAmount), 449);
    });
  });
  it("historical orders are untouched: an order carrying a SAVE50 discount still reads back its coupon, amount and final total", async () => {
    await inRollback(async (tx) => {
      const { create } = await setup(tx);
      const r = await create({ discount: FIFTY });
      // Simulate an order created before this change (metadata + reason written by the old coupon flow).
      const old = { originalSubtotal: "499.00", discountType: "FIXED", discountValue: "50.00", discountAmount: "50.00", couponId: uid(), couponCode: "SAVE50", source: "COUPON", wasDefault: true, finalTotal: "449.00" };
      await tx.order.update({ where: { id: r.order.id }, data: { discountReason: "Coupon SAVE50", metadata: { discount: old } as never } });
      const row = await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { discountReason: true, discountAmount: true, totalAmount: true, metadata: true } });
      assert.deepEqual([row.discountReason, Number(row.discountAmount), Number(row.totalAmount), (row.metadata as any).discount.couponCode], ["Coupon SAVE50", 50, 449, "SAVE50"]);
    });
  });
});
