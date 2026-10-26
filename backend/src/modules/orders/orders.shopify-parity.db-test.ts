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
  dropped?: ("shippingAddress" | "billingAddress" | "requiresShipping" | "tags" | "metafields")[];
  /** after orderUpdate the dropped address / metafields are saved. */
  repairWorks?: boolean;
  /** the total Shopify reports on read-back (default: the CRM total, 1248.00). */
  total?: string;
  /** orderCreate answers with a transport error AFTER creating (a timeout): the order exists but the CRM never hears. */
  timeoutAfterCreate?: boolean;
  /** customerCreate answers with a userError (e.g. the phone is taken). */
  customerCreateFails?: boolean | "taken";
  /** what the phone search returns once customerCreate has been called (a customer made by a parallel request, or an index that caught up) */
  customersAfterCreate?: unknown[];
}

function fakeShopify(script: Script = {}) {
  const calls = { create: [] as any[], update: [] as any[], verify: 0, customerSearch: 0, tagsAdd: 0, customerCreate: [] as any[], customerUpdate: [] as any[] };
  let sent: any = null;
  let repaired = false;
  let created = false;
  const shopifyId = String(Math.floor(1e8 + Math.random() * 9e8));
  const client = {
    query: async (doc: string, vars: any) => {
      if (/customers\(/.test(doc) || /query.*customers/i.test(doc)) {
        calls.customerSearch += 1;
        if (script.customersError) throw new Error("503");
        return { customers: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: ((calls.customerCreate.length > 0 && script.customersAfterCreate ? script.customersAfterCreate : script.customers) ?? []).map((c: any) => ({ id: c.id, firstName: c.firstName ?? null, lastName: c.lastName ?? null, email: c.email ?? null, phone: c.phone ?? null, numberOfOrders: "1", amountSpent: null, defaultAddress: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" })) } };
      }
      if (/customerCreate/.test(doc)) {
        calls.customerCreate.push(vars.input);
        if (script.customerCreateFails) return { customerCreate: { customer: null, userErrors: [{ field: ["phone"], message: script.customerCreateFails === "taken" ? "Phone has already been taken" : "Phone is invalid" }] } };
        return { customerCreate: { customer: { id: "gid://shopify/Customer/777", firstName: vars.input.firstName ?? null, lastName: vars.input.lastName ?? null }, userErrors: [] } };
      }
      if (/customerUpdate/.test(doc)) {
        calls.customerUpdate.push(vars.input);
        return { customerUpdate: { customer: { id: vars.input.id, firstName: vars.input.firstName ?? null, lastName: vars.input.lastName ?? null }, userErrors: [] } };
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
          billingAddress: drop.includes("billingAddress") || !sent.billingAddress ? null : { address1: sent.billingAddress.address1, city: sent.billingAddress.city, zip: sent.billingAddress.zip },
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

async function world(tx: Prisma.TransactionClient, over: { metadata?: Record<string, unknown>; address?: Record<string, unknown> | null; lead?: { email?: string | null; firstName?: string; lastName?: string | null } } = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const creator = await tx.user.create({ data: { name: "Aayush Tiwari", username: `c-${uid()}`, role: Role.SALESPERSON } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: over.lead?.firstName ?? "Anil", lastName: over.lead?.lastName ?? null, mobile: "9811900001", normalizedMobile: "+919811900001", email: over.lead && "email" in over.lead ? over.lead.email : "anil@example.invalid", ownerId: creator.id } });
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
      assert.deepEqual([r.sync?.status, r.sync?.missing.includes("totals"), r.sync?.totals?.difference], ["failed", true, "-50.00"]);
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

describe("Shopify customer name (regression: a lead with no e-mail got no Shopify customer, so no name)", () => {
  it("a lead with a phone but no e-mail and no Shopify match: the customer is CREATED with the CRM first/last name and phone, then associated with the order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { lead: { email: null, firstName: "Meera", lastName: "Rao" } });
      const f = fakeShopify({ customers: [] });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.status, "created");
      assert.deepEqual(f.calls.customerCreate, [{ phone: "+919811900001", firstName: "Meera", lastName: "Rao" }]);
      assert.deepEqual(f.calls.create[0].customer, { toAssociate: { id: "gid://shopify/Customer/777" } });
      assert.equal(f.calls.create.length, 1, "one order, no second attempt");
    });
  });

  it("a single-word name is sent as a first name only (nothing invented), whitespace is trimmed", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { lead: { email: null, firstName: "  Radhe ", lastName: null } });
      const f = fakeShopify({ customers: [] });
      await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.deepEqual(f.calls.customerCreate[0], { phone: "+919811900001", firstName: "Radhe" });
    });
  });

  it("a verified existing Shopify customer WITHOUT a name gets the CRM name; one that already has a name is never touched; the customer is the one matched on phone, not by name", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { lead: { email: null, firstName: "Meera", lastName: "Rao" } });
      const blank = fakeShopify({ customers: [{ id: "gid://shopify/Customer/55", phone: "+919811900001" }] });
      await new OrdersService(tx, () => blank.client).pushOrderToShopify(w.as, w.order.id);
      assert.deepEqual(blank.calls.customerUpdate, [{ id: "gid://shopify/Customer/55", firstName: "Meera", lastName: "Rao" }]);
      assert.deepEqual(blank.calls.create[0].customer, { toAssociate: { id: "gid://shopify/Customer/55" } });
      assert.equal(blank.calls.customerCreate.length, 0, "an existing customer is not duplicated");
    });
    await inRollback(async (tx) => {
      const w = await world(tx, { lead: { email: null, firstName: "Meera", lastName: "Rao" } });
      const named = fakeShopify({ customers: [{ id: "gid://shopify/Customer/56", phone: "+919811900001", firstName: "Existing", lastName: "Name" }] });
      await new OrdersService(tx, () => named.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(named.calls.customerUpdate.length, 0, "a valid existing name is not overwritten");
      assert.equal(named.calls.customerCreate.length, 0);
    });
  });

  it("if Shopify will not create the customer the order is STILL created once, with its shipping line and discount, and the sync says why it is partial", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { lead: { email: null, firstName: "Meera", lastName: "Rao" } });
      const f = fakeShopify({ customers: [], customerCreateFails: true });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.status, "created");
      assert.equal(f.calls.create.length, 1);
      assert.equal(f.calls.create[0].customer, undefined);
      assert.ok(f.calls.create[0].discountCode, "the CRM discount is still sent");
      assert.equal(r.sync?.status, "partial");
      assert.match(r.sync!.customer, /could not be created/);
    });
  });
});

describe("CRM -> Shopify price parity (regression: refusing the customer must never drop the shipping line or discount)", () => {
  it("when Shopify refuses the customer the retry keeps the items, the discount AND the shipping line, so items - discount + shipping is still the CRM total", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await tx.order.update({ where: { id: w.order.id }, data: { shippingAmount: "50.00", totalAmount: "1298.00" } }); // items 1298 - discount 50 + shipping 50
      const f = fakeShopify({ customers: [], rejectCustomer: true, total: "1298.00" });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.status, "created");
      const [first, retry] = f.calls.create;
      assert.ok(first.customer && !retry.customer, "only the customer association is dropped");
      for (const key of ["lineItems", "discountCode", "shippingLines"]) assert.deepEqual(retry[key], first[key], key);
      const itemsTotal = retry.lineItems.reduce((s: number, l: any) => s + Number(l.priceSet.shopMoney.amount) * l.quantity, 0);
      const total = itemsTotal - Number(retry.discountCode.itemFixedDiscountCode.amountSet.shopMoney.amount) + Number(retry.shippingLines[0].priceSet.shopMoney.amount);
      assert.equal(total.toFixed(2), "1298.00");
    });
  });
});

describe("Shopify customer creation retry (phone already taken)", () => {
  const leadNoEmail = { lead: { email: null, firstName: "Meera", lastName: "Rao" } };

  it("a customer made by a parallel request (create refused as a duplicate) is found by phone and associated - never created twice, name filled if blank", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, leadNoEmail);
      const f = fakeShopify({ customers: [], customerCreateFails: "taken", customersAfterCreate: [{ id: "gid://shopify/Customer/88", phone: "+919811900001" }] });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.status, "created");
      assert.equal(f.calls.customerCreate.length, 1, "one create attempt, no second customer");
      assert.deepEqual(f.calls.create[0].customer, { toAssociate: { id: "gid://shopify/Customer/88" } }, "the association is not lost");
      assert.deepEqual(f.calls.customerUpdate, [{ id: "gid://shopify/Customer/88", firstName: "Meera", lastName: "Rao" }]);
      assert.equal(f.calls.create.length, 1);
    });
  });

  it("an existing customer that already has a name keeps it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, leadNoEmail);
      const f = fakeShopify({ customers: [], customerCreateFails: "taken", customersAfterCreate: [{ id: "gid://shopify/Customer/89", phone: "+919811900001", firstName: "Existing", lastName: "Name" }] });
      await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.deepEqual(f.calls.create[0].customer, { toAssociate: { id: "gid://shopify/Customer/89" } });
      assert.equal(f.calls.customerUpdate.length, 0);
    });
  });

  it("two different Shopify customers on that phone: none is attached (no mixing), the order is still created once with its charges", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, leadNoEmail);
      const f = fakeShopify({ customers: [], customerCreateFails: "taken", customersAfterCreate: [{ id: "gid://shopify/Customer/1", phone: "+919811900001" }, { id: "gid://shopify/Customer/2", phone: "+919811900001" }] });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.status, "created");
      assert.equal(f.calls.create[0].customer, undefined);
      assert.ok(f.calls.create[0].discountCode);
      assert.match(r.sync!.customer, /different Shopify customers/);
      assert.equal(f.calls.customerCreate.length, 1);
    });
  });

  it("the duplicate cannot be found even on the second look: the order is created without a customer, nothing is duplicated, and the note says so", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, leadNoEmail);
      const f = fakeShopify({ customers: [], customerCreateFails: "taken", customersAfterCreate: [] });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.status, "created");
      assert.equal(f.calls.create[0].customer, undefined);
      assert.match(r.sync!.customer, /could not be found yet/);
      assert.equal(r.sync?.status, "partial");
      assert.equal(f.calls.customerCreate.length, 1);
    });
  });
});

describe("regression: order #AWL105195 - CRM 649 + 50 shipping = 699 must reach Shopify as 699, not 649", () => {
  /** One unit at 649.00 + 50.00 shipping, no discount, no tax, COD, a phone-only lead (the shape of the production order). */
  async function shippingOrder(tx: Prisma.TransactionClient, lead: { email: string | null }) {
    const w = await world(tx, { lead: { email: lead.email, firstName: "Meera", lastName: "Rao" } });
    const items = await tx.orderItem.findMany({ where: { orderId: w.order.id }, select: { id: true } });
    await tx.orderItem.delete({ where: { id: items[1]!.id } });
    await tx.order.update({ where: { id: w.order.id }, data: { subtotal: "649.00", discountAmount: "0.00", shippingAmount: "50.00", taxAmount: "0.00", totalAmount: "699.00", discountReason: null } });
    return w;
  }
  const sentTotal = (o: any) => o.lineItems.reduce((s: number, l: any) => s + Number(l.priceSet.shopMoney.amount) * l.quantity, 0) - Number(o.discountCode?.itemFixedDiscountCode.amountSet.shopMoney.amount ?? 0) + Number(o.shippingLines?.[0]?.priceSet.shopMoney.amount ?? 0);

  it("phone-only lead: the customer is created first, the order carries the 50.00 shipping line, and the total Shopify holds is 699.00 and verifies as complete", async () => {
    await inRollback(async (tx) => {
      const w = await shippingOrder(tx, { email: null });
      const f = fakeShopify({ customers: [], total: "699.00" });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.status, "created");
      const sent = f.calls.create[0];
      assert.equal(f.calls.create.length, 1, "no refused first attempt any more");
      assert.deepEqual(sent.shippingLines, [{ title: "Shipping", priceSet: { shopMoney: { amount: "50.00", currencyCode: "INR" } } }]);
      assert.equal(sentTotal(sent).toFixed(2), "699.00");
      assert.ok(sent.customer?.toAssociate, "associated with the created customer, so the name reaches Shopify");
      assert.equal(r.sync?.status, "complete");
      assert.equal(((await tx.order.findUniqueOrThrow({ where: { id: w.order.id }, select: { metadata: true } })).metadata as any).shopifyTotals.mirrored, true);
    });
  });

  it("an e-mail lead whose customer Shopify refuses: the retry drops ONLY the customer - the 50.00 shipping line stays, so the total is still 699.00 (the production failure sent 649.00)", async () => {
    await inRollback(async (tx) => {
      const w = await shippingOrder(tx, { email: "meera@example.invalid" });
      const f = fakeShopify({ customers: [], rejectCustomer: true, total: "699.00" });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.status, "created");
      assert.equal(f.calls.create.length, 2);
      assert.ok(f.calls.create[0].customer && !f.calls.create[1].customer);
      assert.equal(sentTotal(f.calls.create[1]).toFixed(2), "699.00");
      assert.equal(f.calls.create[1].shippingLines[0].priceSet.shopMoney.amount, "50.00");
      assert.equal(r.sync?.status, "partial", "reported as partial because the customer was dropped, never as complete");
    });
  });

  it("if Shopify reports a different total than the CRM expects (649 for 699) the sync is marked failed with both amounts - it is never shown as complete", async () => {
    await inRollback(async (tx) => {
      const w = await shippingOrder(tx, { email: null });
      const f = fakeShopify({ customers: [], total: "649.00" });
      const r = await new OrdersService(tx, () => f.client).pushOrderToShopify(w.as, w.order.id);
      assert.equal(r.sync?.status, "failed");
      assert.deepEqual([r.sync?.totals?.expected, r.sync?.totals?.actual, r.sync?.totals?.difference], ["699.00", "649.00", "50.00"]);
    });
  });
});
