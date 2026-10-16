// CRM -> Shopify data parity through the REAL OrdersService.pushOrderToShopify / resyncShopifyOrder. ONE rolled-back transaction on the isolated test database; synthetic data; Shopify is a scripted fake - nothing real is called.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShopifyApiError, type ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "./orders.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());
const uid = () => randomUUID();

interface Script {
  customers?: unknown[];
  customersError?: boolean;
  /** orderCreate: refuse when the request carries a customer (a phone/e-mail that belongs to someone else). */
  rejectCustomer?: boolean;
  /** what the read-back returns: everything saved, except these. */
  dropped?: ("shippingAddress" | "requiresShipping" | "tags" | "metafields")[];
  /** after orderUpdate the dropped address / metafields are saved. */
  repairWorks?: boolean;
  /** the total Shopify reports on read-back (default: the CRM total, 1248.00). */
  total?: string;
  /** orderCreate answers with a transport error AFTER creating (a timeout): the order exists but the CRM never hears. */
  timeoutAfterCreate?: boolean;
}

function fakeShopify(script: Script = {}) {
  const calls = { create: [] as any[], update: [] as any[], verify: 0, customerSearch: 0, tagsAdd: 0 };
  let sent: any = null;
  let repaired = false;
  let created = false;
  const shopifyId = String(Math.floor(1e8 + Math.random() * 9e8));
  const client = {
    query: async (doc: string, vars: any) => {
      if (/customers\(/.test(doc) || /query.*customers/i.test(doc)) {
        calls.customerSearch += 1;
        if (script.customersError) throw new Error("503");
        return { customers: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: (script.customers ?? []).map((c: any) => ({ id: c.id, firstName: null, lastName: null, email: c.email ?? null, phone: c.phone ?? null, numberOfOrders: "1", amountSpent: null, defaultAddress: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" })) } };
      }
      if (/orderCreate/.test(doc)) {
        calls.create.push(vars.order);
        if (script.rejectCustomer && vars.order.customer) return { orderCreate: { order: null, userErrors: [{ field: ["customer"], message: "Phone has already been taken" }] } };
        sent = vars.order;
        created = true;
        if (script.timeoutAfterCreate && calls.create.length === 1) throw new ShopifyApiError("timeout");
        return { orderCreate: { order: { id: `gid://shopify/Order/${shopifyId}`, name: `#T${shopifyId}` }, userErrors: [] } };
      }
      if (/crmOrderBySource/.test(doc)) return { orders: { nodes: created ? [{ id: `gid://shopify/Order/${shopifyId}`, name: `#T${shopifyId}` }] : [] } };
      if (/crmOrderVerify/.test(doc)) {
        calls.verify += 1;
        const drop = script.dropped ?? [];
        const healed = repaired && script.repairWorks;
        return { order: { id: "x", note: sent.note, tags: drop.includes("tags") ? [] : sent.tags ?? [], displayFinancialStatus: "Pending", totalPriceSet: { shopMoney: { amount: script.total ?? "1248.00" } }, customer: sent.customer ? { id: "c" } : null,
          shippingAddress: (drop.includes("shippingAddress") && !healed) || !sent.shippingAddress ? null : { address1: sent.shippingAddress.address1, city: sent.shippingAddress.city, zip: sent.shippingAddress.zip, provinceCode: sent.shippingAddress.provinceCode, countryCodeV2: "IN", firstName: sent.shippingAddress.firstName },
          lineItems: { nodes: sent.lineItems.map(() => ({ requiresShipping: !drop.includes("requiresShipping") })) }, metafields: { nodes: drop.includes("metafields") && !healed ? [] : (sent.metafields ?? []).map((m: any) => ({ key: m.key })) } } };
      }
      if (/orderUpdate/.test(doc)) { calls.update.push(vars.input); repaired = true; return { orderUpdate: { order: { id: "x" }, userErrors: [] } }; }
      if (/tagsAdd/.test(doc)) { calls.tagsAdd += 1; return { tagsAdd: { userErrors: [] } }; }
      // tag read/remove and everything else: harmless empty answers
      return { order: { id: `gid://shopify/Order/${shopifyId}`, tags: [] }, tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } };
    },
  } as unknown as ShopifyClient;
  return { client, calls, shopifyId };
}

async function world(tx: Prisma.TransactionClient, over: { metadata?: Record<string, unknown>; address?: Record<string, unknown> | null } = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const creator = await tx.user.create({ data: { name: "Aayush Tiwari", username: `c-${uid()}`, role: Role.SALESPERSON } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Anil", mobile: "9811900001", normalizedMobile: "+919811900001", email: "anil@example.invalid", ownerId: creator.id } });
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "649.00" } });
  const variant = await tx.productVariant.create({ data: { productId: product.id, name: "60 Pouches", price: "649.00", externalId: String(Math.floor(1e8 + Math.random() * 9e8)), externalSource: "SHOPIFY" } });
  const address = over.address === undefined ? { name: "Anil Kumar Verma", line1: "Flat 7, Green Heights", line2: "Baner Road, Baner, Near Garden", houseNumber: "Flat 7", landmark: "Near Garden", deliveryInstructions: "Call before delivery", addressType: "HOME", city: "Pune", state: "Maharashtra", pincode: "411045", phone: "9811900001" } : over.address;
  const order = await tx.order.create({
    data: {
      orderNumber: `CRM-${uid().slice(0, 8)}`, leadId: lead.id, source: "SALESPERSON", status: "PENDING_PAYMENT", subtotal: "1298.00", discountAmount: "50.00", discountReason: "Custom discount", shippingAmount: "0.00", totalAmount: "1248.00",
      createdById: creator.id, shippingPincode: "411045", ...(address ? { shippingAddress: address as Prisma.InputJsonValue } : {}),
      metadata: { createdVia: "WHATSAPP_INBOX", createdBy: { id: creator.id, name: "Aayush Tiwari", role: "SALESPERSON" }, ...(over.metadata ?? {}) } as Prisma.InputJsonValue,
      items: { create: [1, 2].map(() => ({ productId: product.id, variantId: variant.id, productNameSnapshot: "Herbal Masala", variantNameSnapshot: "60 Pouches", skuSnapshot: "HM-60", quantity: 1, unitPrice: "649.00", totalPrice: "649.00" })) },
      payments: { create: { amount: "1248.00", method: "PAYMENT_LINK", status: "PENDING" } },
    },
    select: { id: true },
  });
  const as = { id: admin.id, username: admin.username, role: Role.ADMIN };
  return { order, as, tx, variantExternalId: variant.externalId! };
}

describe("CRM -> Shopify parity (pushOrderToShopify)", () => {
  it("sends the customer, shipping AND billing address, items as shipping-required, discount, tags, note and metafields; verifies them; stays PENDING", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify({ customers: [] });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.status, "created");
      const o = f.calls.create[0];
      assert.deepEqual(o.customer, { toUpsert: { email: "anil@example.invalid", phone: "+919811900001", firstName: "Anil", lastName: "Kumar Verma" } });
      assert.deepEqual(o.shippingAddress, { firstName: "Anil Kumar", lastName: "Verma", address1: "Flat 7, Green Heights", address2: "Baner Road, Baner, Near Garden", city: "Pune", provinceCode: "MH", zip: "411045", countryCode: "IN", phone: "9811900001" });
      assert.deepEqual(o.billingAddress, o.shippingAddress);
      assert.deepEqual(o.lineItems.map((l: any) => [l.variantId, l.requiresShipping]), [[`gid://shopify/ProductVariant/${w.variantExternalId}`, true], [`gid://shopify/ProductVariant/${w.variantExternalId}`, true]]);
      assert.equal(o.discountCode.itemFixedDiscountCode.amountSet.shopMoney.amount, "50.00");
      assert.equal(o.financialStatus, "PENDING");
      assert.deepEqual(o.tags, ["CRM", "CRM Source: WhatsApp Inbox", "Order Created by Aayush Tiwari"]);
      assert.match(o.note, /Created by Aayush Tiwari/);
      assert.match(o.note, /Delivery instructions: Call before delivery/);
      assert.equal(o.metafields.find((m: any) => m.key === "lead_number").namespace, "crm");
      assert.equal(o.sourceIdentifier.startsWith("CRM-"), true);
      assert.equal(r.sync?.status, "complete");
      assert.deepEqual(r.sync?.missing, []);
      assert.equal(r.sync?.retryAdvice, "NONE");
      assert.ok(r.sync?.verifiedAt);
      const stored = await tx.order.findUniqueOrThrow({ where: { id: w.order.id }, select: { metadata: true, payments: { select: { status: true } }, status: true } });
      assert.equal((stored.metadata as any).shopifySync.status, "complete");
      assert.deepEqual(stored.payments.map((p) => p.status), ["PENDING"], "the CRM payment is untouched");
      assert.equal(stored.status, "PENDING_PAYMENT");
    });
  });

  it("an abandoned-checkout order is tagged and described as such (not as a WhatsApp Inbox order)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { metadata: { abandonment: { id: uid(), referenceId: "cart-1" } } });
      const f = fakeShopify();
      await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.ok(f.calls.create[0].tags.includes("CRM Source: Abandoned Checkout"));
      assert.match(f.calls.create[0].note, /Abandoned checkout/);
    });
  });

  it("an existing verified Shopify customer is associated; two different matches are not guessed (partial); a failed lookup does not stop the order (partial)", async () => {
    await inRollback(async (tx) => {
      const a = await world(tx);
      const one = fakeShopify({ customers: [{ id: "gid://shopify/Customer/55", phone: "+919811900001" }] });
      const r1 = await new OrdersService(tx, () => one.client).pushOrderToShopify(a.as, a.order.id);
      assert.deepEqual(one.calls.create[0].customer, { toAssociate: { id: "gid://shopify/Customer/55" } });
      assert.equal(r1.sync?.status, "complete");

      const b = await world(tx);
      const two = fakeShopify({ customers: [{ id: "gid://shopify/Customer/1", phone: "+919811900001" }, { id: "gid://shopify/Customer/2", email: "anil@example.invalid" }] });
      const r2 = await new OrdersService(tx, () => two.client).pushOrderToShopify(b.as, b.order.id);
      assert.equal(two.calls.create[0].customer, undefined);
      assert.match(r2.sync!.omitted.join(" "), /2 different Shopify customers/);
      assert.equal(r2.sync!.status, "partial", "an unattached customer is never a complete sync");
      assert.equal(r2.sync!.retryAdvice, "ADMIN");

      const c = await world(tx);
      const down = fakeShopify({ customersError: true });
      const r3 = await new OrdersService(tx, () => down.client).pushOrderToShopify(c.as, c.order.id);
      assert.equal(r3.status, "created");
      assert.equal(down.calls.create[0].customer, undefined);
      assert.equal(r3.sync?.status, "partial");
    });
  });

  it("Shopify refusing the customer is retried WITHOUT it, reported, and NEVER shown as complete - the order is still created once", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify({ customers: [], rejectCustomer: true });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.status, "created");
      assert.equal(f.calls.create.length, 2);
      assert.equal(f.calls.create[1].customer, undefined);
      assert.match(r.sync!.omitted.join(" "), /customer \(Shopify refused it/);
      assert.equal(r.sync!.status, "partial", "a fallback that dropped the customer must not look complete");
      assert.ok(r.sync!.missing.some((m) => m.startsWith("customer")));
    });
  });

  it("fields Shopify silently dropped are repaired once (shipping address) and the sync is complete only when verified", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify({ dropped: ["shippingAddress"], repairWorks: true });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.deepEqual(Object.keys(f.calls.update[0]).sort(), ["id", "shippingAddress"]);
      assert.deepEqual([r.sync?.status, r.sync?.repaired], ["complete", ["shippingAddress"]]);
    });
  });

  it("anything still missing after the repair is a PARTIAL sync - recorded, never complete; the order is still linked once", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify({ dropped: ["shippingAddress", "requiresShipping", "tags"], repairWorks: false });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.status, "created");
      assert.equal(r.sync?.status, "partial");
      assert.deepEqual(r.sync?.missing.sort(), ["lineItems.requiresShipping", "shippingAddress", "tags"]);
      assert.equal(r.sync?.verifiedAt, null);
      assert.equal(r.sync?.retryAdvice, "ADMIN", "Shopify cannot change shipping-required on an existing order");
      const stored = await tx.order.findUniqueOrThrow({ where: { id: w.order.id }, select: { externalId: true, metadata: true } });
      assert.equal(stored.externalId, f.shopifyId);
      assert.equal((stored.metadata as any).shopifySync.status, "partial");
    });
  });

  it("a retry never creates a second Shopify order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify();
      const svc = new OrdersService(tx, () => f.client);
      assert.equal((await svc.pushOrderToShopify(w.as, w.order.id)).status, "created");
      assert.equal((await svc.pushOrderToShopify(w.as, w.order.id)).status, "already_linked");
      assert.equal(f.calls.create.length, 1);
    });
  });

  it("an order with no saved address still syncs (the address is reported as omitted, nothing blank is sent)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { address: null });
      const f = fakeShopify();
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.status, "created");
      assert.equal(f.calls.create[0].shippingAddress, undefined);
      assert.match(r.sync!.omitted.join(" "), /shippingAddress: the CRM order has no shipping address/);
    });
  });

  it("a total that does not reconcile with the CRM is reported (never a complete sync)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify({ total: "1298.00" });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.deepEqual([r.sync?.status, r.sync?.missing.includes("totals")], ["partial", true]);
    });
  });

  it("timeout AFTER Shopify created the order: the retry finds it by the CRM reference, creates nothing, and verifies it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify({ timeoutAfterCreate: true });
      const svc = new OrdersService(tx, () => f.client);
      const first = await svc.pushOrderToShopify(w.as, w.order.id);
      assert.equal(first.status, "failed");
      assert.match(first.reason!, /Retry will look for it before creating another/);
      const second = await svc.pushOrderToShopify(w.as, w.order.id);
      assert.equal(second.status, "created");
      assert.equal(f.calls.create.length, 1, "no second Shopify order was created");
      assert.ok(second.sync, "the found order was read back and verified");
      const stored = await tx.order.findUniqueOrThrow({ where: { id: w.order.id }, select: { externalId: true } });
      assert.equal(stored.externalId, f.shopifyId);
    });
  });

  it("re-sync of a partial order creates nothing and writes only the missing address / metafields / tags; the result is stored; payment untouched", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify({ dropped: ["shippingAddress", "metafields", "tags"], repairWorks: false });
      const svc = new OrdersService(tx, () => f.client);
      const first = await svc.pushOrderToShopify(w.as, w.order.id);
      assert.equal(first.sync?.status, "partial");
      f.calls.update.length = 0;
      const again = await svc.resyncShopifyOrder(w.as, w.order.id);
      assert.equal(f.calls.create.length, 1, "still only the original creation");
      for (const u of f.calls.update) assert.deepEqual(Object.keys(u).filter((k) => !["id", "shippingAddress", "metafields"].includes(k)), []);
      assert.ok(f.calls.tagsAdd >= 1, "missing tags are ADDED (add-only), never replaced");
      assert.equal(again.sync?.status, "partial", "Shopify (scripted) still does not save them, so it is honestly still partial");
      const stored = await tx.order.findUniqueOrThrow({ where: { id: w.order.id }, select: { metadata: true, payments: { select: { status: true } } } });
      assert.equal((stored.metadata as any).shopifySync.status, "partial");
      assert.deepEqual(stored.payments.map((p) => p.status), ["PENDING"]);
    });
  });

  it("re-sync of a healthy order writes nothing at all", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify();
      const svc = new OrdersService(tx, () => f.client);
      await svc.pushOrderToShopify(w.as, w.order.id);
      const tagsBefore = f.calls.tagsAdd; // the creator-tag sync that follows a push is its own (add-only) step
      const again = await svc.resyncShopifyOrder(w.as, w.order.id);
      assert.equal(again.sync?.status, "complete");
      assert.deepEqual([f.calls.create.length, f.calls.update.length, f.calls.tagsAdd - tagsBefore], [1, 0, 0]);
    });
  });

  it("only an administrator or manager may re-sync; an unlinked order is told to push first; a salesperson is refused", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify();
      const svc = new OrdersService(tx, () => f.client);
      const unlinked = await svc.resyncShopifyOrder(w.as, w.order.id);
      assert.equal(unlinked.status, "failed");
      assert.match(unlinked.reason!, /not linked to Shopify yet/);
      await assert.rejects(() => svc.resyncShopifyOrder({ ...w.as, role: Role.SALESPERSON }, w.order.id), (e: { statusCode?: number }) => e.statusCode === 403);
      assert.equal(f.calls.create.length, 0);
    });
  });
});
