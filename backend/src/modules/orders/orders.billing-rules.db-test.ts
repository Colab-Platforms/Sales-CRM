// Billing rules for a new order, decided by the server (the browser's figures are only a preview):
//   PREPAID: shipping is always Rs 0 (whatever the request carries); the existing prepaid promotion (the configured default discount) applies.
//   COD:     the shipping charge is added; the automatic default discount is NOT applied (a discount chosen on purpose still is).
// The persisted order, the Shopify order payload and the Cashfree link amount must all agree. REAL OrdersService + REAL CashfreePaymentsService (fake provider API) inside ONE rolled-back
// transaction on the isolated test database: no payment link is created at Cashfree, nothing is sent to Shopify or WhatsApp.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import CashfreePaymentsService, { type CashfreeApi } from "../cashfree/cashfree.payments.service.js";
import type { CashfreeLink } from "../cashfree/cashfree.client.js";
import { setDefaultOffersSource } from "../discounts/discounts.service.js";
import OrdersService from "./orders.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(async () => { setDefaultOffersSource(null); await prisma.$disconnect(); });

const uid = () => randomUUID();
const CONFIG = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret", PUBLIC_BACKEND_URL: "https://crm.example.com" });
const DEFAULT_50 = { type: "FIXED", value: "50" } as const;

async function world(tx: Prisma.TransactionClient) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN }, select: { id: true, username: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Billing", mobile: "9811300001", normalizedMobile: "+919811300001", ownerId: admin.id }, select: { id: true } });
  const product = await tx.product.create({ data: { name: "Herbal Tea", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "449.00" }, select: { id: true } });

  const shopifyOrders: any[] = [];
  const shopify = { query: async (_q: string, variables: any) => { if (variables?.order) shopifyOrders.push(variables.order); return { orderCreate: { order: { id: `gid://shopify/Order/${randomInt(1e9, 9e9)}`, name: "#T1" }, userErrors: [] } }; } } as unknown as ShopifyClient;
  const linkAmounts: string[] = [];
  const api: CashfreeApi = {
    createLink: async (request) => { linkAmounts.push(String(request.link_amount)); return { cfLinkId: "1", linkId: request.link_id, linkStatus: "ACTIVE", linkUrl: `https://pay.test/${request.link_id}`, linkAmount: String(request.link_amount), linkAmountPaid: "0", linkExpiryTime: null } as unknown as CashfreeLink; },
    getLink: async (linkId) => ({ cfLinkId: "1", linkId, linkStatus: "ACTIVE", linkUrl: `https://pay.test/${linkId}`, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null }) as unknown as CashfreeLink,
    cancelLink: async (linkId) => ({ cfLinkId: "1", linkId, linkStatus: "CANCELLED", linkUrl: null, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null }) as unknown as CashfreeLink,
  };
  const cashfree = new CashfreePaymentsService({ $transaction: (cb: (t: never) => unknown) => cb(tx as never) } as never, { config: () => CONFIG, client: () => api });
  const notify = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;
  const orders = new OrdersService(tx as never, () => shopify, () => cashfree as never, notify);
  const as = { id: admin.id, username: admin.username, role: Role.ADMIN };

  const place = async (paymentMethod: "COD" | "PAYMENT_LINK", extra: Record<string, unknown> = {}) => {
    const r = await orders.createManualOrder(as, { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "449.00" }], paymentMethod, ...(paymentMethod === "PAYMENT_LINK" ? { sendPaymentLinkViaWhatsApp: false } : {}), ...extra } as never);
    const row = await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { subtotal: true, discountAmount: true, shippingAmount: true, totalAmount: true } });
    return { r, row: { subtotal: row.subtotal.toString(), discount: row.discountAmount.toString(), shipping: row.shippingAmount.toString(), total: row.totalAmount.toString() }, shopify: shopifyOrders.at(-1), linkAmounts };
  };
  return { place, orders, as, lead, shopifyOrders, linkAmounts, tx };
}
const num = (v: string) => Number(v);

describe("PREPAID orders: no shipping, existing prepaid promotion", () => {
  it("a shipping charge in the request is ignored: shipping 0, the default Rs 50 discount applies, total 399 - in the database, the Shopify payload and the Cashfree link", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { r, row, shopify, linkAmounts } = await w.place("PAYMENT_LINK", { shippingAmount: "80.00", discount: DEFAULT_50 });
      assert.deepEqual(row, { subtotal: "449", discount: "50", shipping: "0", total: "399" });
      assert.equal(num(r.order.shippingAmount), 0);
      assert.equal(num(r.order.totalAmount), 399);
      assert.equal(shopify.shippingLines, undefined, "no hidden shipping line is sent to Shopify");
      assert.equal(Number(shopify.discountCode?.itemFixedDiscountCode?.amountSet?.shopMoney?.amount), 50);
      assert.deepEqual(linkAmounts, ["399"], "the payment link is for exactly the persisted total");
    });
  });

  it("without any discount or shipping the prepaid total is just the items", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { row, shopify, linkAmounts } = await w.place("PAYMENT_LINK");
      assert.deepEqual(row, { subtotal: "449", discount: "0", shipping: "0", total: "449" });
      assert.equal(shopify.shippingLines, undefined);
      assert.deepEqual(linkAmounts, ["449"]);
    });
  });

  it("boundary: even a 1-paisa shipping value on a prepaid order is dropped", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { row } = await w.place("PAYMENT_LINK", { shippingAmount: "0.01" });
      assert.equal(row.shipping, "0");
      assert.equal(row.total, "449");
    });
  });
});

describe("COD orders: shipping added, no automatic discount", () => {
  it("shipping 80 is added and the default Rs 50 discount is NOT applied: total 529 everywhere", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { r, row, shopify } = await w.place("COD", { shippingAmount: "80.00", discount: DEFAULT_50 });
      assert.deepEqual(row, { subtotal: "449", discount: "0", shipping: "80", total: "529" });
      assert.equal(num(r.order.totalAmount), 529);
      assert.equal(num(r.order.discountAmount), 0);
      assert.equal(shopify.discountCode, undefined, "the dropped discount is not sent to Shopify");
      assert.equal(shopify.shippingLines?.[0]?.priceSet?.shopMoney?.amount, "80.00");
    });
  });

  it("a discount chosen on purpose (not the default) is left alone on COD", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { row } = await w.place("COD", { shippingAmount: "80.00", discount: { type: "FIXED", value: "20" } });
      assert.deepEqual(row, { subtotal: "449", discount: "20", shipping: "80", total: "509" });
    });
  });

  it("a deliberate Fastrr coupon is left alone on COD", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      setDefaultOffersSource({ getActiveOffers: async () => ({ offers: [{ id: "fr-1", couponCode: "SAVE100", discountType: "flat", discountValue: 100, automaticDiscount: false, startTime: null, endTime: null, active: true, minCartTotal: null, minQtyProduct: null, productFilter: null, expiringSoon: false }] as never, fetchedAt: new Date().toISOString() }) });
      try {
        const { row } = await w.place("COD", { shippingAmount: "60.00", discount: { couponCode: "SAVE100" } });
        assert.deepEqual(row, { subtotal: "449", discount: "100", shipping: "60", total: "409" });
      } finally {
        setDefaultOffersSource(null);
      }
    });
  });

  it("boundary: COD with no / zero shipping and the default discount is just the items", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      assert.deepEqual((await w.place("COD", { discount: DEFAULT_50 })).row, { subtotal: "449", discount: "0", shipping: "0", total: "449" });
      assert.deepEqual((await w.place("COD", { shippingAmount: "0", discount: DEFAULT_50 })).row, { subtotal: "449", discount: "0", shipping: "0", total: "449" });
    });
  });
});

describe("the server is the authority", () => {
  it("expectedTotal is checked against the server's total: the old prepaid figure (with shipping) is refused, the new one is accepted", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await assert.rejects(() => w.place("PAYMENT_LINK", { shippingAmount: "80.00", discount: DEFAULT_50, expectedTotal: "479.00" }), /order total changed/i);
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 0, "nothing is created on a mismatch");
      const ok = await w.place("PAYMENT_LINK", { shippingAmount: "80.00", discount: DEFAULT_50, expectedTotal: "399.00" });
      assert.equal(ok.row.total, "399");
    });
  });

  it("an idempotent retry returns the SAME order with the SAME figures and creates nothing new", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const key = uid();
      const first = await w.place("COD", { shippingAmount: "80.00", discount: DEFAULT_50, idempotencyKey: key });
      const again = await w.place("COD", { shippingAmount: "80.00", discount: DEFAULT_50, idempotencyKey: key });
      assert.equal(again.r.order.id, first.r.order.id);
      assert.deepEqual(again.row, first.row);
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 1);
      assert.equal(w.shopifyOrders.length, 1, "Shopify is not asked for a second order");
    });
  });
});
