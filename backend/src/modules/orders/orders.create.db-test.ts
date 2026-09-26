// Database integration tests for E7.8 (WhatsApp -> CRM Order -> Shopify). Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back - mirrors the other db-test
// files in this project. No real Shopify call is ever made: pushOrderToShopify's Shopify client is
// always the injected fake below, never the real ShopifyClient/credentials.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "./orders.service.js";

class Rollback extends Error {}

async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });

async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Mahadev", lastName: "Babar", mobile: "9876543210", normalizedMobile: "+919876543210", email: "mahadev@example.invalid", ...overrides },
    select: { id: true },
  });
}

async function makeProduct(tx: Prisma.TransactionClient, overrides: Partial<Prisma.ProductUncheckedCreateInput> = {}) {
  return tx.product.create({
    data: { name: "Herbal Tea 100g", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "349.00", ...overrides },
    select: { id: true, name: true, sku: true },
  });
}

async function makeVariant(tx: Prisma.TransactionClient, productId: string, overrides: Partial<Prisma.ProductVariantUncheckedCreateInput> = {}) {
  return tx.productVariant.create({
    data: { productId, name: "Default", price: "349.00", ...overrides },
    select: { id: true, name: true },
  });
}

const DEFAULT_ORDER_CREATE_RESPONSE = { orderCreate: { order: { id: "gid://shopify/Order/1", name: "#TST1" }, userErrors: [] as { field: string[] | null; message: string }[] } };

function fakeShopifyClient(queryImpl?: (document: string, variables: Record<string, unknown>) => Promise<unknown>): ShopifyClient {
  return { query: queryImpl ?? (async () => DEFAULT_ORDER_CREATE_RESPONSE) } as unknown as ShopifyClient;
}

describe("createManualOrder - idempotencyKey guards a double submit", () => {
  it("two concurrent calls with the SAME idempotencyKey create exactly one order and one Shopify push", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      let shopifyCalls = 0;
      const svc = new OrdersService(tx, () => fakeShopifyClient(async () => { shopifyCalls += 1; return { orderCreate: { order: { id: "gid://shopify/Order/1", name: "#TST1" }, userErrors: [] } }; }));
      const input = { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "349.00" as const }], paymentMethod: "COD" as const, idempotencyKey: `idem-${uid()}` };

      // Simulates a double-click: two calls fired back-to-back, before the first has resolved.
      const [a, b] = await Promise.all([svc.createManualOrder(as(admin, Role.ADMIN), input), svc.createManualOrder(as(admin, Role.ADMIN), input)]);

      assert.equal(a.order.id, b.order.id, "both calls resolve to the SAME order, not two");
      assert.equal(await tx.order.count({ where: { leadId: lead.id } }), 1, "exactly one CRM order was created");
      assert.equal(shopifyCalls, 1, "exactly one Shopify push, never two");
    });
  });

  it("a different idempotencyKey (or none at all) is a genuinely new order - never falsely deduplicated", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      let n = 0;
      const svc = new OrdersService(tx, () => fakeShopifyClient(async () => { n += 1; return { orderCreate: { order: { id: `gid://shopify/Order/${n}`, name: `#TST${n}` }, userErrors: [] } }; }));
      const base = { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "349.00" as const }], paymentMethod: "COD" as const };

      const first = await svc.createManualOrder(as(admin, Role.ADMIN), { ...base, idempotencyKey: `idem-${uid()}` });
      const second = await svc.createManualOrder(as(admin, Role.ADMIN), { ...base, idempotencyKey: `idem-${uid()}` });
      const third = await svc.createManualOrder(as(admin, Role.ADMIN), base);

      assert.equal(new Set([first.order.id, second.order.id, third.order.id]).size, 3);
      assert.equal(await tx.order.count({ where: { leadId: lead.id } }), 3);
    });
  });

  it("the same idempotencyKey from a DIFFERENT user is never deduplicated against another user's order", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const manager = await tx.user.create({ data: { name: "Admin B", email: `b-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      let n = 0;
      const svc = new OrdersService(tx, () => fakeShopifyClient(async () => { n += 1; return { orderCreate: { order: { id: `gid://shopify/Order/${n}`, name: `#TST${n}` }, userErrors: [] } }; }));
      const sharedKey = `idem-${uid()}`;
      const input = { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "349.00" as const }], paymentMethod: "COD" as const, idempotencyKey: sharedKey };

      const a = await svc.createManualOrder(as(admin, Role.ADMIN), input);
      const b = await svc.createManualOrder(as(manager, Role.ADMIN), input);
      assert.notEqual(a.order.id, b.order.id);
    });
  });

  it("a failed attempt is never cached - retrying the same idempotencyKey after a failure creates the order normally", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const svc = new OrdersService(tx, () => fakeShopifyClient());
      const key = `idem-${uid()}`;

      await assert.rejects(() => svc.createManualOrder(as(admin, Role.ADMIN), { leadId: lead.id, items: [{ productId: randomUUID(), quantity: 1, unitPrice: "1.00" }], paymentMethod: "COD", idempotencyKey: key }));

      const product = await makeProduct(tx);
      const result = await svc.createManualOrder(as(admin, Role.ADMIN), { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "349.00" }], paymentMethod: "COD", idempotencyKey: key });
      assert.ok(result.order.id);
    });
  });
});

describe("createManualOrder (WhatsApp Inbox -> CRM Order)", () => {
  it("full happy path: creates the order/items/payment, audits it, and appears via getOrder/listOrders", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      const svc = new OrdersService(tx, () => fakeShopifyClient());

      const result = await svc.createManualOrder(as(admin, Role.ADMIN), {
        leadId: lead.id,
        items: [{ productId: product.id, quantity: 2, unitPrice: "349.00" }],
        paymentMethod: "COD",
        shippingAddress: { line1: "123 Main St", city: "Mumbai", state: "Maharashtra", pincode: "400001" },
      });

      assert.equal(result.order.status, "CONFIRMED", "COD orders are confirmed immediately");
      assert.equal(result.order.items.length, 1);
      assert.equal(result.order.items[0]!.quantity, 2);
      assert.equal(result.order.totalAmount, "698");
      assert.equal(result.order.paymentMode, "COD");
      assert.ok(result.order.orderNumber.startsWith("CRM-"));

      const activity = await tx.activity.findFirst({ where: { orderId: result.order.id, type: "ORDER_CREATED" } });
      assert.ok(activity, "the order creation is audited");

      // Same read paths the rest of the app already uses - no parallel WhatsApp-only record.
      const fetched = await svc.getOrder(as(admin, Role.ADMIN), result.order.id);
      assert.equal(fetched.id, result.order.id);
      const listed = await svc.listOrders(as(admin, Role.ADMIN), { page: 1, pageSize: 20 });
      assert.ok(listed.items.some((o) => o.id === result.order.id));
    });
  });

  it("a prepaid (non-COD) order starts PENDING_PAYMENT, not CONFIRMED", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      const svc = new OrdersService(tx, () => fakeShopifyClient());

      const result = await svc.createManualOrder(as(admin, Role.ADMIN), {
        leadId: lead.id,
        items: [{ productId: product.id, quantity: 1, unitPrice: "349.00" }],
        paymentMethod: "UPI",
      });

      assert.equal(result.order.status, "PENDING_PAYMENT");
      assert.equal(result.order.paymentMode, "PREPAID");
    });
  });

  it("computes totals correctly with a per-item discount, order-level discount, and shipping", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      const svc = new OrdersService(tx, () => fakeShopifyClient());

      // 2 x 349.00 = 698.00, minus a 20.00 item discount, minus a 30.00 order discount, plus 49.00 shipping = 697.00
      const result = await svc.createManualOrder(as(admin, Role.ADMIN), {
        leadId: lead.id,
        items: [{ productId: product.id, quantity: 2, unitPrice: "349.00", discountAmount: "20.00" }],
        discountAmount: "30.00",
        shippingAmount: "49.00",
        paymentMethod: "COD",
      });

      assert.equal(result.order.subtotal, "698");
      assert.equal(result.order.discountAmount, "50");
      assert.equal(result.order.shippingAmount, "49");
      assert.equal(result.order.totalAmount, "697");
    });
  });

  it("a salesperson can create an order for their own lead", async () => {
    await inRollback(async (tx) => {
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const lead = await makeLead(tx, { ownerId: rep.id });
      const product = await makeProduct(tx);
      const svc = new OrdersService(tx, () => fakeShopifyClient());

      const result = await svc.createManualOrder(as(rep, Role.SALESPERSON), {
        leadId: lead.id,
        items: [{ productId: product.id, quantity: 1, unitPrice: "349.00" }],
        paymentMethod: "COD",
      });
      assert.equal(result.order.customer.leadId, lead.id);
    });
  });

  it("404s (never leaks existence) for a lead outside the caller's scope, and persists nothing", async () => {
    await inRollback(async (tx) => {
      const rep1 = await tx.user.create({ data: { name: "Rep1", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const otherLead = await makeLead(tx, { ownerId: rep2.id });
      const product = await makeProduct(tx);
      const svc = new OrdersService(tx, () => fakeShopifyClient());

      await assert.rejects(
        () => svc.createManualOrder(as(rep1, Role.SALESPERSON), { leadId: otherLead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "349.00" }], paymentMethod: "COD" }),
        (e: any) => e.statusCode === 404,
      );
      assert.equal(await tx.order.count({ where: { leadId: otherLead.id } }), 0);
    });
  });

  it("rejects an unknown product, and persists nothing", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const svc = new OrdersService(tx, () => fakeShopifyClient());

      await assert.rejects(
        () => svc.createManualOrder(as(admin, Role.ADMIN), { leadId: lead.id, items: [{ productId: randomUUID(), quantity: 1, unitPrice: "100.00" }], paymentMethod: "COD" }),
        (e: any) => e.statusCode === 400,
      );
      assert.equal(await tx.order.count({ where: { leadId: lead.id } }), 0);
    });
  });

  it("rejects a variant that does not belong to the given product", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const productA = await makeProduct(tx);
      const productB = await makeProduct(tx);
      const variantOfB = await makeVariant(tx, productB.id);
      const svc = new OrdersService(tx, () => fakeShopifyClient());

      await assert.rejects(
        () => svc.createManualOrder(as(admin, Role.ADMIN), { leadId: lead.id, items: [{ productId: productA.id, variantId: variantOfB.id, quantity: 1, unitPrice: "100.00" }], paymentMethod: "COD" }),
        (e: any) => e.statusCode === 400,
      );
    });
  });
});

describe("createManualOrder's Shopify push - variant id sent to Shopify (mocked client)", () => {
  async function orderWithVariant(tx: Prisma.TransactionClient, variant: { externalSource?: "SHOPIFY" | null; externalId?: string | null }) {
    const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
    const lead = await makeLead(tx);
    const product = await makeProduct(tx);
    const v = await tx.productVariant.create({ data: { productId: product.id, name: "1 Jar", price: "1199.00", externalSource: variant.externalSource ?? null, externalId: variant.externalId ?? null }, select: { id: true } });
    return { admin, lead, product, variant: v };
  }
  const input = (leadId: string, productId: string, variantId: string) => ({ leadId, items: [{ productId, variantId, quantity: 1, unitPrice: "1199.00" }], paymentMethod: "COD" as const });

  it("a Shopify-synced variant stored numeric is sent to orderCreate as a ProductVariant GID, and the order links to Shopify", async () => {
    await inRollback(async (tx) => {
      const numeric = `45${Math.floor(Math.random() * 1e12)}`;
      const { admin, lead, product, variant } = await orderWithVariant(tx, { externalSource: "SHOPIFY", externalId: numeric });
      const sent: any[] = [];
      const svc = new OrdersService(tx, () => fakeShopifyClient(async (_doc, vars) => { sent.push(vars); return { orderCreate: { order: { id: `gid://shopify/Order/${uid()}`, name: "#TSTV" }, userErrors: [] } }; }));

      const result = await svc.createManualOrder(as(admin, Role.ADMIN), input(lead.id, product.id, variant.id));

      assert.equal(result.shopify.status, "created");
      assert.equal(sent.length, 1);
      assert.equal((sent[0].order as any).lineItems[0].variantId, `gid://shopify/ProductVariant/${numeric}`);
    });
  });

  it("an invalid stored Shopify variant id fails clearly, Shopify is never called, and the CRM order is unaffected", async () => {
    await inRollback(async (tx) => {
      const { admin, lead, product, variant } = await orderWithVariant(tx, { externalSource: "SHOPIFY", externalId: "not-a-variant-id" });
      let called = 0;
      const svc = new OrdersService(tx, () => fakeShopifyClient(async () => { called += 1; return DEFAULT_ORDER_CREATE_RESPONSE; }));

      const result = await svc.createManualOrder(as(admin, Role.ADMIN), input(lead.id, product.id, variant.id));

      assert.equal(result.shopify.status, "failed");
      assert.match(result.shopify.reason ?? "", /not a valid Shopify product variant id/);
      assert.equal(called, 0);
      assert.equal(await tx.order.count({ where: { leadId: lead.id } }), 1, "the CRM order exists exactly once");
      assert.equal(result.order.status, "CONFIRMED");
    });
  });

  it("retry after that failure still works once the id is valid, and creates exactly one Shopify order", async () => {
    await inRollback(async (tx) => {
      const { admin, lead, product, variant } = await orderWithVariant(tx, { externalSource: "SHOPIFY", externalId: "bad id" });
      let created = 0;
      const svc = new OrdersService(tx, () => fakeShopifyClient(async () => { created += 1; return { orderCreate: { order: { id: "gid://shopify/Order/5150", name: "#RETRY" }, userErrors: [] } }; }));
      const first = await svc.createManualOrder(as(admin, Role.ADMIN), input(lead.id, product.id, variant.id));
      assert.equal(first.shopify.status, "failed");

      await tx.productVariant.update({ where: { id: variant.id }, data: { externalId: `46${Math.floor(Math.random() * 1e12)}` } }); // the data is corrected
      const retry = await svc.pushOrderToShopify(as(admin, Role.ADMIN), first.order.id);
      const again = await svc.pushOrderToShopify(as(admin, Role.ADMIN), first.order.id);

      assert.equal(retry.status, "created");
      assert.equal(again.status, "already_linked");
      assert.equal(created, 1, "one Shopify order in total, never a duplicate");
      assert.equal(await tx.order.count({ where: { leadId: lead.id } }), 1);
    });
  });

  it("a variant with no Shopify link (or from another source) is sent as a custom line item - never given a variant id", async () => {
    await inRollback(async (tx) => {
      const { admin, lead, product, variant } = await orderWithVariant(tx, { externalSource: null, externalId: null });
      const sent: any[] = [];
      const svc = new OrdersService(tx, () => fakeShopifyClient(async (_doc, vars) => { sent.push(vars); return DEFAULT_ORDER_CREATE_RESPONSE; }));
      // give the CRM variant an id that LOOKS numeric but has no Shopify source: it must not be treated as a Shopify id
      await tx.productVariant.update({ where: { id: variant.id }, data: { externalId: "123456" } });
      await svc.createManualOrder(as(admin, Role.ADMIN), input(lead.id, product.id, variant.id));
      const item = (sent[0].order as any).lineItems[0];
      assert.equal(item.variantId, undefined);
      assert.ok(item.title, "sent as a custom item with a title and price instead");
    });
  });
});

describe("createManualOrder's Shopify push (mocked client - never a real Shopify call)", () => {
  it("links the CRM order to Shopify on success", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      const variant = await makeVariant(tx, product.id, { externalSource: "SHOPIFY", externalId: "gid://shopify/ProductVariant/1" });
      const svc = new OrdersService(tx, () => fakeShopifyClient(async () => ({ orderCreate: { order: { id: "gid://shopify/Order/555", name: "#TST555" }, userErrors: [] } })));

      const result = await svc.createManualOrder(as(admin, Role.ADMIN), {
        leadId: lead.id,
        items: [{ productId: product.id, variantId: variant.id, quantity: 1, unitPrice: "349.00" }],
        paymentMethod: "COD",
      });

      assert.deepEqual(result.shopify, { status: "created", shopifyOrderId: "gid://shopify/Order/555", shopifyOrderName: "#TST555" });
      const stored = await tx.order.findUniqueOrThrow({ where: { id: result.order.id }, select: { externalSource: true, externalId: true, externalNumber: true } });
      assert.equal(stored.externalSource, "SHOPIFY");
      assert.equal(stored.externalId, "gid://shopify/Order/555");
      assert.equal(stored.externalNumber, "#TST555");
    });
  });

  it("reports a Shopify failure honestly - the CRM order is still created and unaffected", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      const svc = new OrdersService(tx, () => fakeShopifyClient(async () => ({ orderCreate: { order: null, userErrors: [{ field: null, message: "Variant not found" }] } })));

      const result = await svc.createManualOrder(as(admin, Role.ADMIN), {
        leadId: lead.id,
        items: [{ productId: product.id, quantity: 1, unitPrice: "349.00" }],
        paymentMethod: "COD",
      });

      assert.equal(result.shopify.status, "failed");
      assert.match(result.shopify.reason ?? "", /Variant not found/);
      // The CRM order itself is completely real and unaffected by the Shopify failure.
      assert.equal(result.order.status, "CONFIRMED");
      const stored = await tx.order.findUniqueOrThrow({ where: { id: result.order.id }, select: { externalId: true } });
      assert.equal(stored.externalId, null);
    });
  });

  it("retrying pushOrderToShopify after a failure succeeds without creating a duplicate CRM order", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      let calls = 0;
      const svc = new OrdersService(tx, () => fakeShopifyClient(async () => {
        calls++;
        if (calls === 1) return { orderCreate: { order: null, userErrors: [{ field: null, message: "Temporary failure" }] } };
        return { orderCreate: { order: { id: "gid://shopify/Order/777", name: "#TST777" }, userErrors: [] } };
      }));

      const first = await svc.createManualOrder(as(admin, Role.ADMIN), { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "349.00" }], paymentMethod: "COD" });
      assert.equal(first.shopify.status, "failed");

      const retry = await svc.pushOrderToShopify(as(admin, Role.ADMIN), first.order.id);
      assert.deepEqual(retry, { status: "created", shopifyOrderId: "gid://shopify/Order/777", shopifyOrderName: "#TST777" });

      assert.equal(await tx.order.count({ where: { leadId: lead.id } }), 1, "still exactly one CRM order - never duplicated by the retry");
      assert.equal(calls, 2);
    });
  });

  it("never calls Shopify again for an order already linked - returns already_linked", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      let calls = 0;
      const svc = new OrdersService(tx, () => fakeShopifyClient(async () => { calls++; return { orderCreate: { order: { id: "gid://shopify/Order/1", name: "#TST1" }, userErrors: [] } }; }));

      const created = await svc.createManualOrder(as(admin, Role.ADMIN), { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "349.00" }], paymentMethod: "COD" });
      assert.equal(created.shopify.status, "created");
      assert.equal(calls, 1);

      const again = await svc.pushOrderToShopify(as(admin, Role.ADMIN), created.order.id);
      assert.deepEqual(again, { status: "already_linked", shopifyOrderId: "gid://shopify/Order/1", shopifyOrderName: "#TST1" });
      assert.equal(calls, 1, "Shopify was never called a second time");
    });
  });

  it("a Shopify-synced order (already has an externalId) is reported already_linked, never re-pushed", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await tx.order.create({
        data: { orderNumber: `SHP-${uid()}`, leadId: lead.id, source: "SHOPIFY", status: "CONFIRMED", totalAmount: "100.00", externalSource: "SHOPIFY", externalId: "gid://shopify/Order/existing", externalNumber: "#EXIST1" },
        select: { id: true },
      });
      let called = false;
      const svc = new OrdersService(tx, () => fakeShopifyClient(async () => { called = true; return { orderCreate: { order: null, userErrors: [] } }; }));

      const result = await svc.pushOrderToShopify(as(admin, Role.ADMIN), order.id);
      assert.deepEqual(result, { status: "already_linked", shopifyOrderId: "gid://shopify/Order/existing", shopifyOrderName: "#EXIST1" });
      assert.equal(called, false);
    });
  });
});

describe("getLastShippingAddress (Create Order prefill)", () => {
  it("returns the customer's most recent order address, understanding both the CRM and Shopify shapes", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      await tx.order.create({ data: { orderNumber: `O-${uid()}`, leadId: lead.id, source: "SHOPIFY", status: "CONFIRMED", totalAmount: "10.00", shippingAddress: { name: "Old", address1: "1 Old Rd", city: "Pune", province: "Maharashtra", zip: "411001" } } });
      const svc = new OrdersService(tx);
      assert.equal((await svc.getLastShippingAddress(as(admin, Role.ADMIN), lead.id)).address?.line1, "1 Old Rd", "Shopify shape (address1/province/zip)");
      await tx.order.create({ data: { orderNumber: `O-${uid()}`, leadId: lead.id, source: "SALESPERSON", status: "CONFIRMED", totalAmount: "10.00", createdAt: new Date(Date.now() + 60_000), shippingAddress: { name: "Priya Shah", line1: "12 MG Road", line2: "Near Park", city: "Mumbai", state: "Maharashtra", pincode: "400001", phone: "9000000123" } } });
      const latest = await svc.getLastShippingAddress(as(admin, Role.ADMIN), lead.id);
      assert.deepEqual(latest.address, { name: "Priya Shah", line1: "12 MG Road", line2: "Near Park", city: "Mumbai", state: "Maharashtra", pincode: "400001", phone: "9000000123" });
    });
  });

  it("is null when the customer has no saved address, and out-of-scope customers read as not found", async () => {
    await inRollback(async (tx) => {
      const owner = await tx.user.create({ data: { name: "Owner", email: `o-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const stranger = await tx.user.create({ data: { name: "Stranger", email: `s-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const lead = await makeLead(tx, { ownerId: owner.id });
      const svc = new OrdersService(tx);
      assert.equal((await svc.getLastShippingAddress(as(owner, Role.SALESPERSON), lead.id)).address, null);
      await assert.rejects(() => svc.getLastShippingAddress(as(stranger, Role.SALESPERSON), lead.id), (e: any) => e.statusCode === 404);
    });
  });
});
