// Custom (free-form) order items next to Shopify catalogue items, against the real schema. ONE rolled-back transaction per test on the isolated test database; Shopify and Cashfree are scripted
// fakes: nothing real is created, charged or messaged. A custom item has NO product / variant: it is stored on the order line itself and sent to Shopify as a custom line item.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import CashfreePaymentsService, { type CashfreeApi } from "../cashfree/cashfree.payments.service.js";
import type { CashfreeLink } from "../cashfree/cashfree.client.js";
import OrdersService from "./orders.service.js";
import { validateCreateManualOrder } from "./orders.validators.js";

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
const CONFIG = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret", PUBLIC_BACKEND_URL: "https://crm.example.com" });

/** A scripted Shopify: stores every orderCreate payload, can refuse the first N creates, and answers the read-back like the real one. */
function fakeShopify(opts: { failCreate?: number; taxPercent?: number } = {}) {
  const state = { created: [] as any[], refused: 0 };
  let failures = opts.failCreate ?? 0;
  const money = (v: number) => ({ shopMoney: { amount: v.toFixed(2) } });
  // A shop with tax rates configured adds tax to TAXABLE lines (tax-exclusive pricing); the CRM never does.
  const tax = (o: any) => ((o.lineItems ?? []) as any[]).filter((l) => l.taxable !== false && l.taxable === true).reduce((s2: number, l: any) => s2 + Number(l.priceSet?.shopMoney?.amount ?? 0) * Number(l.quantity ?? 1), 0) * (opts.taxPercent ?? 0) / 100;
  const total = (o: any) => tax(o) + (o.lineItems ?? []).reduce((s: number, l: any) => s + Number(l.priceSet?.shopMoney?.amount ?? 0) * Number(l.quantity ?? 1), 0) - Number(o.discountCode?.itemFixedDiscountCode?.amountSet?.shopMoney?.amount ?? 0) + Number((o.shippingLines ?? []).reduce((s: number, l: any) => s + Number(l.priceSet?.shopMoney?.amount ?? 0), 0));
  const address = (a: any) => (a ? { address1: a.address1 ?? null, city: a.city ?? null, zip: a.zip ?? null, provinceCode: a.provinceCode ?? null, countryCodeV2: a.countryCode ?? null, lastName: a.lastName ?? null, firstName: a.firstName ?? null } : null);
  const client = {
    query: async (doc: string, vars: any) => {
      if (/customers\(/.test(doc)) return { customers: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [] } };
      if (/crmOrderBySource/.test(doc)) {
        const ref = /source_identifier:"(.*)"/.exec(String(vars.query))?.[1];
        return { orders: { nodes: state.created.filter((o) => o.sourceIdentifier === ref).map((o) => ({ id: o.id, name: o.name })) } };
      }
      if (/orderCreate/.test(doc)) {
        if (failures > 0) { failures -= 1; state.refused += 1; return { orderCreate: { order: null, userErrors: [{ field: ["lineItems"], message: "Shopify refused the line items" }] } }; }
        const n = String(Math.floor(1e8 + Math.random() * 9e8));
        state.created.push({ ...vars.order, id: `gid://shopify/Order/${n}`, name: `#T${n}` });
        return { orderCreate: { order: { id: `gid://shopify/Order/${n}`, name: `#T${n}` }, userErrors: [] } };
      }
      if (/crmOrderVerify/.test(doc)) {
        const o = state.created.find((c) => c.id === vars.id) ?? state.created.at(-1);
        return { order: { id: o.id, note: o.note, tags: o.tags ?? [], displayFinancialStatus: "Pending", totalPriceSet: money(total(o)), customer: o.customer ? { id: "c" } : null,
          shippingAddress: address(o.shippingAddress), billingAddress: address(o.billingAddress),
          lineItems: { nodes: (o.lineItems ?? []).map((l: any) => ({ requiresShipping: l.requiresShipping !== false, taxable: l.taxable !== false })) }, metafields: { nodes: (o.metafields ?? []).map((m: any) => ({ key: m.key })) } } };
      }
      return { order: { id: "gid://shopify/Order/1", tags: [] }, tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } };
    },
  } as unknown as ShopifyClient;
  return { client, state };
}

async function world(tx: Prisma.TransactionClient, shopOpts: Parameters<typeof fakeShopify>[0] = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN }, select: { id: true, username: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Doddesh", mobile: "9902575944", normalizedMobile: "+919902575944", ownerId: admin.id }, select: { id: true } });
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "649.00" }, select: { id: true } });
  const variant = await tx.productVariant.create({ data: { productId: product.id, name: "60 Pouches", price: "649.00", externalId: String(Math.floor(1e8 + Math.random() * 9e8)), externalSource: "SHOPIFY" }, select: { id: true, externalId: true } });
  const shop = fakeShopify(shopOpts);
  const links: string[] = [];
  const api: CashfreeApi = {
    createLink: async (request) => { links.push(request.link_id); return { cfLinkId: "1", linkId: request.link_id, linkStatus: "ACTIVE", linkUrl: `https://pay.test/${request.link_id}`, linkAmount: String(request.link_amount), linkAmountPaid: "0", linkExpiryTime: null } as unknown as CashfreeLink; },
    getLink: async (linkId) => ({ cfLinkId: "1", linkId, linkStatus: "ACTIVE", linkUrl: `https://pay.test/${linkId}`, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null }) as unknown as CashfreeLink,
    cancelLink: async () => null,
  };
  const cashfree = new CashfreePaymentsService({ $transaction: (cb: (t: never) => unknown) => cb(tx as never) } as never, { config: () => CONFIG, client: () => api });
  const notify = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;
  const orders = new OrdersService(tx as never, () => shop.client, () => cashfree as never, notify);
  const as = { id: admin.id, username: admin.username, role: Role.ADMIN };
  const address = { name: "Doddesh", line1: "New Bus stand karatagi", line2: "Koppal", houseNumber: "New Bus stand karatagi", area: "Koppal", city: "Koppal", state: "Karnataka", pincode: "583229", phone: "9902575944" };
  const create = (method: "COD" | "PAYMENT_LINK", items: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    orders.createManualOrder(as, { leadId: lead.id, items, paymentMethod: method, shippingAddress: address, shippingPincode: "583229", ...(method === "PAYMENT_LINK" ? { sendPaymentLinkViaWhatsApp: false, discount: { none: true } } : { shippingAmount: "0" }), ...extra } as never);
  const catalog = (qty = 1, price = "649.00") => ({ productId: product.id, variantId: variant.id, quantity: qty, unitPrice: price });
  return { tx, orders, as, lead, product, variant, shop, links, create, catalog };
}
const custom = (over: Record<string, unknown> = {}) => ({ itemType: "CUSTOM", customName: "Gift wrapping", quantity: 1, unitPrice: "99.00", ...over });
const dbItems = (tx: Prisma.TransactionClient, orderId: string) => tx.orderItem.findMany({ where: { orderId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

const baseRequest = (item: Record<string, unknown>) => ({
  leadId: uid(), items: [item], paymentMethod: "COD", shippingAddress: { name: "A", line1: "Flat 1", city: "Pune", state: "Maharashtra", pincode: "411045" }, shippingPincode: "411045",
});
const validate = (item: Record<string, unknown>) => validateCreateManualOrder(baseRequest(item));

describe("custom item validation (server side)", () => {
  it("accepts a well-formed custom item (zero price included) and still accepts a catalogue item with no itemType", () => {
    assert.ok(!validate(custom()).error);
    assert.ok(!validate(custom({ unitPrice: "0" })).error, "a free item is a valid price");
    assert.ok(!validate({ productId: uid(), quantity: 1, unitPrice: "10.00" }).error, "existing callers are unchanged");
    assert.ok(!validate(custom({ requiresShipping: true, weight: "0.25", weightUnit: "KG", taxable: true })).error);
  });
  it("rejects a missing / blank name, a bad price, zero / negative / excessive quantity, and an invalid or inconsistent weight - each with an understandable message", () => {
    const msg = (item: Record<string, unknown>) => validate(item).error?.message ?? "";
    assert.match(msg(custom({ customName: undefined })), /Item name is required/);
    assert.match(msg(custom({ customName: "   " })), /Item name is required/);
    assert.match(msg(custom({ customName: "x".repeat(201) })), /200 characters/);
    for (const price of ["-5", "abc", "10.999", ""]) assert.match(msg(custom({ unitPrice: price })), /unitPrice must be a non-negative decimal/, price);
    for (const q of [0, -1, 1.5]) assert.ok(msg(custom({ quantity: q })).length > 0, String(q));
    assert.match(msg(custom({ quantity: 1000 })), /999 or fewer/);
    assert.match(msg(custom({ weight: "abc", weightUnit: "KG" })), /Weight must be a positive number/);
    assert.match(msg(custom({ weight: "0", weightUnit: "KG" })), /greater than 0/);
    assert.match(msg(custom({ weight: "1" })), /both the weight and its unit/);
    assert.match(msg(custom({ weight: "1", weightUnit: "LB" })), /KG or G/);
    assert.match(msg(custom({ requiresShipping: false, weight: "1", weightUnit: "KG" })), /Only a physical item has a weight/);
  });
  it("a custom item cannot carry a product / variant, and a catalogue item cannot carry custom-only fields", () => {
    assert.match(validate(custom({ productId: uid() })).error?.message ?? "", /no product or variant/);
    assert.match(validate({ productId: uid(), quantity: 1, unitPrice: "1.00", customName: "x" }).error?.message ?? "", /Only a custom item/);
    assert.match(validate({ itemType: "CATALOG", quantity: 1, unitPrice: "1.00" }).error?.message ?? "", /product id/i);
  });
});

describe("creating orders with custom items", () => {
  it("catalogue items only: exactly as before - catalogue lines, no custom fields, one Shopify variant line", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("COD", [w.catalog(2)]);
      const [line] = await dbItems(tx, r.order.id);
      assert.deepEqual([line!.itemType, line!.productId, line!.variantId, line!.isTaxable, line!.requiresShipping, line!.weightGrams], ["CATALOG", w.product.id, w.variant.id, null, null, null]);
      assert.equal(String(r.order.subtotal), "1298");
      assert.deepEqual(w.shop.state.created[0].lineItems.map((l: any) => [!!l.variantId, l.title]), [[true, undefined]]);
    });
  });

  it("custom items only: stored on the line with NO product / variant, recalculated server-side, no catalogue product is created, and sent to Shopify as a CUSTOM line item with its taxable / shipping / weight", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const products = await tx.product.count();
      const r = await w.create("COD", [custom({ customName: "  Gift wrapping  ", quantity: 3, unitPrice: "199.50", taxable: false, requiresShipping: true, weight: "0.25", weightUnit: "KG", totalPrice: "1.00", lineTotal: "1.00" })], { subtotal: "1.00", totalAmount: "1.00" });
      const [line] = await dbItems(tx, r.order.id);
      assert.deepEqual([line!.itemType, line!.productId, line!.variantId, line!.productNameSnapshot, line!.quantity, String(line!.unitPrice), String(line!.totalPrice), line!.isTaxable, line!.requiresShipping, String(line!.weightGrams)], ["CUSTOM", null, null, "Gift wrapping", 3, "199.5", "598.5", false, true, "250"]);
      assert.equal(await tx.product.count(), products, "no placeholder catalogue product");
      assert.equal(String(r.order.subtotal), "598.5", "the browser's subtotal / line totals are ignored");
      const sent = w.shop.state.created[0].lineItems[0];
      assert.deepEqual([sent.variantId, sent.title, sent.quantity, sent.priceSet.shopMoney.amount, sent.taxable, sent.requiresShipping, sent.weight], [undefined, "Gift wrapping", 3, "199.5", false, true, { value: 250, unit: "GRAMS" }]);
      assert.equal(r.shopify.status, "created");
    });
  });

  it("a mixed order: the catalogue line keeps its Shopify variant, the custom lines go as custom lines; totals add up; line order is kept", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("COD", [w.catalog(1), custom({ customName: "Installation", unitPrice: "300.00", requiresShipping: false }), custom({ customName: "Extra pouch", unitPrice: "49.50", quantity: 2, taxable: true, weight: "150", weightUnit: "G" })]);
      const items = await dbItems(tx, r.order.id);
      assert.deepEqual(items.map((i) => [i.itemType, i.productNameSnapshot]), [["CATALOG", "Herbal Masala"], ["CUSTOM", "Installation"], ["CUSTOM", "Extra pouch"]]);
      assert.equal(String(r.order.subtotal), String(649 + 300 + 99));
      const lines = w.shop.state.created[0].lineItems;
      assert.deepEqual(lines.map((l: any) => [Boolean(l.variantId), l.title ?? null, l.requiresShipping, l.taxable ?? null]), [[true, null, true, null], [false, "Installation", false, false], [false, "Extra pouch", true, true]]);
      assert.equal(lines[1].weight, undefined, "a non-physical item sends no weight");
      assert.deepEqual(lines[2].weight, { value: 150, unit: "GRAMS" });
    });
  });

  it("several custom items in one order: each persisted and returned by the order API with its type, taxable / physical flags and weight; the catalogue line reports none", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("COD", [custom({ customName: "A", unitPrice: "10.00", taxable: true }), custom({ customName: "B", unitPrice: "20.00", requiresShipping: false }), w.catalog(1)]);
      const detail = await w.orders.getOrder(w.as, r.order.id);
      assert.deepEqual(detail.items.map((i) => [i.itemType, i.productName, i.taxable, i.requiresShipping, i.weightGrams, i.productId === null]), [["CUSTOM", "A", true, true, null, true], ["CUSTOM", "B", false, false, null, true], ["CATALOG", "Herbal Masala", null, null, null, false]]);
      assert.equal(Number(detail.items[0]!.totalPrice), 10);
    });
  });

  it("prepaid: totals include the custom items, a Cashfree link is created for exactly that total, and the Shopify order waits for verified payment", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("PAYMENT_LINK", [custom({ customName: "Consultation", unitPrice: "499.00" }), custom({ customName: "Kit", unitPrice: "100.50", quantity: 2 })]);
      assert.deepEqual([r.order.status, String(r.order.totalAmount), r.shopify.status, r.paymentLink?.status, w.links.length, w.shop.state.created.length], ["PENDING_PAYMENT", "700", "awaiting_payment", "created", 1, 0]);
    });
  });

  it("COD / prepaid figures are unchanged by the feature: same shipping rule, same default discount rule, for catalogue and custom alike", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const cod = await w.create("COD", [w.catalog(1)]);
      const codCustom = await w.create("COD", [custom({ unitPrice: "649.00" })], { acknowledgeDuplicate: true, idempotencyKey: `k-${uid()}` });
      assert.deepEqual([String(codCustom.order.shippingAmount), String(codCustom.order.totalAmount)], [String(cod.order.shippingAmount), String(cod.order.totalAmount)]);
    });
  });
});

describe("custom items: duplicate protection, idempotency and failures", () => {
  it("a retry / double submit with the same key returns the same order: ONE order, one set of lines, one Shopify order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const items = [w.catalog(1), custom({ customName: "Gift", unitPrice: "50.00", weight: "0.1", weightUnit: "KG" })];
      const key = `key-${uid()}`;
      const a = await w.create("COD", items, { idempotencyKey: key });
      const b = await w.create("COD", items, { idempotencyKey: key });
      const [c, d] = await Promise.all([w.create("COD", items, { idempotencyKey: key }), w.create("COD", items, { idempotencyKey: key })]);
      assert.ok([b, c, d].every((x) => x.order.id === a.order.id));
      assert.deepEqual([await tx.order.count({ where: { leadId: w.lead.id } }), (await dbItems(tx, a.order.id)).length, w.shop.state.created.length], [1, 2, 1]);
    });
  });

  it("the same key with a DIFFERENT custom item is refused (422) and creates nothing", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const key = `key-${uid()}`;
      await w.create("COD", [custom({ unitPrice: "99.00" })], { idempotencyKey: key });
      await assert.rejects(() => w.create("COD", [custom({ unitPrice: "98.00" })], { idempotencyKey: key }), (e: any) => e.statusCode === 422);
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 1);
    });
  });

  it("the recent-duplicate guard sees custom lines: the same custom item again is a possible duplicate, a different name or price is not", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.create("COD", [custom({ customName: "Gift wrapping", unitPrice: "99.00" })], { idempotencyKey: `k-${uid()}` });
      await assert.rejects(() => w.create("COD", [custom({ customName: "gift wrapping", unitPrice: "99.00" })], { idempotencyKey: `k-${uid()}`, rejectRecentTwin: true }), (e: any) => e.statusCode === 409 && e.data?.code === "POSSIBLE_DUPLICATE_ORDER");
      await w.create("COD", [custom({ customName: "Gift wrapping", unitPrice: "109.00" })], { idempotencyKey: `k-${uid()}`, rejectRecentTwin: true });
      await w.create("COD", [custom({ customName: "Installation", unitPrice: "99.00" })], { idempotencyKey: `k-${uid()}`, rejectRecentTwin: true });
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 3);
    });
  });

  it("a Shopify refusal is reported with its reason, the CRM order and its custom lines are kept, and the retry creates the ONE Shopify order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { failCreate: 1 }); // a lead without an e-mail has no customer to drop, so one refusal is the whole first attempt
      const r = await w.create("COD", [w.catalog(1), custom({ customName: "Gift", unitPrice: "50.00" })]);
      assert.equal(r.shopify.status, "failed");
      assert.match(r.shopify.reason ?? "", /refused the line items/);
      assert.deepEqual([(await dbItems(tx, r.order.id)).length, (await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { externalId: true } })).externalId], [2, null]);
      const retry = await w.orders.pushOrderToShopify(w.as, r.order.id);
      assert.equal(retry.status, "created");
      assert.equal((await w.orders.pushOrderToShopify(w.as, r.order.id)).status, "already_linked");
      assert.deepEqual([w.shop.state.created.length, w.shop.state.created[0].lineItems.length], [1, 2]);
    });
  });

  it("TAXABLE risk: if the shop adds tax to a taxable custom item, Shopify's total differs from the CRM total - the sync is reported FAILED / needs attention with 'totals' missing (never silently complete), and the CRM total is not changed; a non-taxable item stays complete", async () => {
    await inRollback(async (tx) => {
      const taxed = await world(tx, { taxPercent: 18 });
      const r = await taxed.create("COD", [custom({ customName: "Taxable thing", unitPrice: "1000.00", taxable: true })]);
      const sync = (r.shopify as any).sync;
      assert.equal(r.shopify.status, "created", "the order exists on Shopify");
      assert.deepEqual([sync.status, sync.missing.includes("totals"), sync.retryAdvice, sync.totals?.category], ["failed", true, "ADMIN", "total_mismatch"], JSON.stringify(sync));
      assert.equal(String(r.order.subtotal), "1000", "the CRM adds no tax and keeps its own figures");
      const plain = await world(tx, { taxPercent: 18 });
      const ok = await plain.create("COD", [custom({ customName: "Not taxable", unitPrice: "1000.00", taxable: false })]);
      assert.equal((ok.shopify as any).sync.status, "complete");
    });
  });

  it("the sync record is honest: weight and the taxable flag are listed as sent-but-unverifiable, never as verified", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("COD", [custom({ taxable: true, weight: "0.5", weightUnit: "KG" })]);
      const sync = (r.shopify as any).sync;
      const omitted: string[] = sync?.omitted ?? [];
      assert.ok(omitted.some((o) => o.startsWith("lineItems.weight")), JSON.stringify(sync));
      assert.ok(omitted.some((o) => o.startsWith("lineItems.taxable")));
    });
  });

  it("existing scope rules apply: an order for a customer outside the user's scope is refused (404) with custom items too, and nothing is created", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const hr = await tx.user.create({ data: { name: "HR", username: `h-${uid()}`, role: Role.HR }, select: { id: true, username: true } });
      await assert.rejects(() => w.orders.createManualOrder({ id: hr.id, username: hr.username, role: Role.HR }, { leadId: w.lead.id, items: [custom()], paymentMethod: "COD", shippingAddress: { name: "x", line1: "Flat 1", city: "Pune", state: "Maharashtra", pincode: "411045" }, shippingPincode: "411045" } as never), (e: any) => e.statusCode === 404);
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 0);
    });
  });
});
