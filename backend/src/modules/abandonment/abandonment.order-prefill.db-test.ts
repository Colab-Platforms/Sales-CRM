// Create Order from an abandoned checkout: the prefill (products, variants, quantities, address, customer) and the order it produces. Every test runs in ONE
// transaction that is always rolled back; Shopify is always a fake. Run with: npm run test:db
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AbandonmentType, ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShopifyApiError, type ShopifyClient } from "../shopify/shopify.client.js";
import { parseAbandonmentEvent } from "../shiprocket/shiprocket.abandonment.mapper.js";
import { buildCartSnapshot } from "../shiprocket/shiprocket.abandonment.processor.js";
import OrdersService from "../orders/orders.service.js";
import { validateCreateManualOrder } from "../orders/orders.validators.js";
import AbandonmentService from "./abandonment.service.js";

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
const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });
const ADDRESS = { first_name: "Priya", last_name: "Shah", phone: "9000000123", address1: "12 Rose Villa", address2: "MG Road", landmark: "Near Park", city: "Pune", state: "Maharashtra", zip: "411001", country: "India" };

/** A realistic Fastrr "Abandon Cart" delivery (the shape confirmed from live deliveries). */
const delivery = (over: Record<string, unknown> = {}) => ({
  cart_id: `cart-${uid()}`, phone_number: "9000000123", email: "priya@example.invalid", first_name: "Priya", last_name: "Shah", total_price: "1398.00", currency: "INR",
  shipping_price: "49", tax: "0", total_discount: "0", source_name: "fastrr", latest_stage: "PAYMENT", updated_at: "2026-10-12 10:00:00",
  items: [
    { product_id: "111", variant_id: "1001", sku: "TEA-100", name: "Herbal Tea", title: "100g", price: "449", quantity: 2, img_url: "https://img.example.invalid/tea.png" },
    { product_id: "222", variant_id: "2002", sku: "GUM-30", name: "Sleep Gummies", title: "30 pack", price: "500", quantity: 1 },
  ],
  shipping_address: ADDRESS, billing_address: ADDRESS, ...over,
});

const DEFAULT_CREATE_RESPONSE = { orderCreate: { order: { id: "gid://shopify/Order/1", name: "#TST1" }, userErrors: [] as { field: string[] | null; message: string }[] } };
function fakeShopify(orderCreate?: () => Promise<unknown>): { client: ShopifyClient; creates: () => number } {
  let creates = 0;
  const query = async (document: string) => {
    if (/orderCreate/.test(document)) { creates++; return orderCreate ? orderCreate() : { orderCreate: { order: { id: `gid://shopify/Order/${Date.now()}${creates}`, name: "#TST1" }, userErrors: [] } }; }
    return { order: { id: "gid://shopify/Order/1", tags: [] }, tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } };
  };
  return { client: { query } as unknown as ShopifyClient, creates: () => creates };
}

async function world(tx: Prisma.TransactionClient) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const rep = await tx.user.create({ data: { name: "Rep", username: `r-${uid()}`, role: Role.SALESPERSON } });
  const otherRep = await tx.user.create({ data: { name: "Other Rep", username: `o-${uid()}`, role: Role.SALESPERSON } });
  // CRM catalogue, linked to the storefront ids the checkout reports.
  const tea = await tx.product.create({ data: { name: "Herbal Tea", type: ProductType.PRODUCT, sku: `TEA-${uid().slice(0, 6)}`, basePrice: "449.00", externalSource: "SHOPIFY", externalId: "111" }, select: { id: true } });
  const teaVariant = await tx.productVariant.create({ data: { productId: tea.id, name: "100g", price: "449.00", sku: "TEA-100", externalSource: "SHOPIFY", externalId: "1001" }, select: { id: true } });
  const gum = await tx.product.create({ data: { name: "Sleep Gummies", type: ProductType.PRODUCT, sku: "GUM-30", basePrice: "500.00", externalSource: "SHOPIFY", externalId: "222" }, select: { id: true } });
  let n = 0;
  const lead = async (over: Partial<Prisma.LeadUncheckedCreateInput> = {}) => {
    n += 1;
    return tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", mobile: `9000000${String(100 + n)}`, normalizedMobile: `+919000000${String(100 + n)}`, ownerId: rep.id, ...over }, select: { id: true, normalizedMobile: true, mobile: true } });
  };
  const checkout = async (leadId: string, payload: Record<string, unknown> | null, opts: { saved?: boolean; referenceId?: string } = { saved: true }) => {
    const parsed = payload ? parseAbandonmentEvent(payload) : null;
    const snapshot = parsed && opts.saved !== false ? buildCartSnapshot(parsed) : null;
    return tx.abandonment.create({ data: { leadId, type: AbandonmentType.CHECKOUT, detectedAt: new Date(), referenceType: "ShiprocketCheckoutCart", referenceId: opts.referenceId ?? (payload?.cart_id as string | undefined) ?? `cart-${uid()}`, cartSnapshot: (snapshot ?? undefined) as Prisma.InputJsonValue | undefined }, select: { id: true, leadId: true, referenceId: true } });
  };
  const svc = new AbandonmentService(tx as never, { bulkAssignManagers: async () => ({ assignedCount: 0 }), bulkAssignSalespersons: async () => ({ assignedCount: 0 }) } as never, null);
  const shop = fakeShopify();
  const orders = new OrdersService(tx as never, () => shop.client);
  const base = { paymentMethod: "COD" as const, shippingAddress: { line1: "12 Rose Villa", line2: "MG Road", city: "Pune", state: "Maharashtra", pincode: "411001", name: "Priya Shah", phone: "9000000123" } };
  return { admin, rep, otherRep, tea, teaVariant, gum, lead, checkout, svc, orders, shop, base, tx };
}

describe("order prefill from an abandoned checkout", () => {
  it("every product line is prefilled with its CRM product, variant, quantity and the website price; ids and SKU are preserved", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead();
      const c = await w.checkout(l.id, delivery());
      const p = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), c.id);
      assert.equal(p.dataFrom, "saved_cart");
      assert.equal(p.lines.length, 2);
      assert.deepEqual(p.lines.map((x) => [x.name, x.quantity, x.websiteUnitPrice, x.matched]), [["Herbal Tea", 2, "449", true], ["Sleep Gummies", 1, "500", true]]);
      assert.equal(p.lines[0]!.productId, w.tea.id, "matched by the storefront product id");
      assert.equal(p.lines[0]!.variantId, w.teaVariant.id, "matched by the storefront variant id");
      assert.equal(p.lines[0]!.variantTitle, "100g");
      assert.equal(p.lines[0]!.imageUrl, "https://img.example.invalid/tea.png");
      assert.equal(p.lines[1]!.productId, w.gum.id, "a product with no variant is matched by id/SKU");
      assert.equal(p.currency, "INR");
      assert.equal(p.totals.total, "1398.00");
      assert.equal(p.totals.shipping, "49");
      assert.deepEqual(p.lines.map((x) => x.key), ["checkout-0", "checkout-1"], "stable keys, so a reload cannot duplicate lines");
    });
  });

  it("the address comes through field by field: postal code, phone, lines, landmark, city, state; plus the customer", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead();
      const c = await w.checkout(l.id, delivery());
      const p = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), c.id);
      assert.deepEqual(p.address, { name: "Priya Shah", phone: "9000000123", line1: "12 Rose Villa", line2: "MG Road", landmark: "Near Park", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India", company: null });
      assert.equal(p.addressKind, "shipping");
      assert.deepEqual(p.customer, { name: "Priya Shah", phone: "9000000123", email: "priya@example.invalid" });
    });
  });

  it("partial data: billing-only address is flagged, a partial address keeps what exists, and no address says so without inventing one", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const billingOnly = await w.checkout((await w.lead()).id, delivery({ shipping_address: null }));
      const pb = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), billingOnly.id);
      assert.equal(pb.addressKind, "billing");
      assert.ok(pb.notes.some((n) => /billing address/i.test(n)));
      const partial = await w.checkout((await w.lead()).id, delivery({ shipping_address: { first_name: "Priya", city: "Pune", phone: "9000000123" }, billing_address: null }));
      const pp = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), partial.id);
      assert.equal(pp.address?.city, "Pune");
      assert.equal(pp.address?.pincode, null, "a field the customer never gave stays empty");
      assert.equal(pp.address?.line1, null);
      const none = await w.checkout((await w.lead()).id, delivery({ shipping_address: null, billing_address: null }));
      const pn = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), none.id);
      assert.equal(pn.address, null);
      assert.ok(pn.notes.some((n) => /No delivery address was captured/.test(n)));
      assert.equal(pn.lines.length, 2, "the products are still prefilled");
    });
  });

  it("no cart data at all: no lines, no fabricated products, a clear message, and the form stays editable", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead();
      const c = await w.checkout(l.id, null, { referenceId: `cart-${uid()}` });
      const p = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), c.id);
      assert.equal(p.dataFrom, "none");
      assert.deepEqual(p.lines, []);
      assert.equal(p.address, null);
      assert.ok(p.notes.some((n) => /No products were captured/.test(n)));
      assert.equal(p.customer.name, "Priya Shah", "the customer comes from the lead");
    });
  });

  it("an item the CRM cannot match is returned UNMATCHED (the salesperson chooses) - never guessed", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead();
      const c = await w.checkout(l.id, delivery({ items: [{ product_id: "999", variant_id: "9999", sku: "NOPE", name: "Mystery Item", price: "10", quantity: 3 }] }));
      const p = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), c.id);
      assert.equal(p.lines[0]!.matched, false);
      assert.equal(p.lines[0]!.productId, null);
      assert.equal(p.lines[0]!.quantity, 3);
      assert.ok(p.notes.some((n) => /could not be matched/.test(n)));
    });
  });

  it("two customers with different carts and addresses never cross-contaminate", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.lead({ firstName: "Priya" });
      const b = await w.lead({ firstName: "Rahul", lastName: "Verma" });
      const ca = await w.checkout(a.id, delivery());
      const cb = await w.checkout(b.id, delivery({ phone_number: "9000000999", first_name: "Rahul", last_name: "Verma", items: [{ product_id: "222", variant_id: null, sku: "GUM-30", name: "Sleep Gummies", price: "500", quantity: 5 }], shipping_address: { first_name: "Rahul", address1: "9 Hill Rd", city: "Delhi", state: "Delhi", zip: "110001", phone: "9000000999" }, billing_address: null }));
      const pa = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), ca.id);
      const pb = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), cb.id);
      assert.equal(pa.address?.city, "Pune");
      assert.equal(pb.address?.city, "Delhi");
      assert.deepEqual(pb.lines.map((x) => [x.name, x.quantity]), [["Sleep Gummies", 5]]);
      assert.equal(pa.lines.length, 2);
      assert.equal(pa.leadId, a.id);
      assert.equal(pb.leadId, b.id);
    });
  });

  it("an old abandonment (no saved detail) is filled from the recorded delivery for the SAME cart and the SAME customer only", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const owner = await w.lead({ normalizedMobile: "+919000000123", mobile: "9000000123" });
      const stranger = await w.lead({ normalizedMobile: "+919111111111", mobile: "9111111111" });
      const payload = delivery({ cart_id: "shared-cart-1" });
      await tx.webhookEvent.create({ data: { provider: "SHIPROCKET_CHECKOUT", eventType: "checkout.abandoned", payload: payload as Prisma.InputJsonValue, status: "PROCESSED", receivedAt: new Date() } });
      const mine = await w.checkout(owner.id, payload, { saved: false });
      const wrong = await w.checkout(stranger.id, payload, { saved: false });
      const p1 = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), mine.id);
      assert.equal(p1.dataFrom, "checkout_delivery");
      assert.equal(p1.lines.length, 2);
      assert.equal(p1.address?.pincode, "411001");
      const p2 = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), wrong.id);
      assert.equal(p2.dataFrom, "none", "a delivery that belongs to a different phone/email is never shown on this lead");
      assert.deepEqual(p2.lines, []);
      assert.equal(p2.address, null);
    });
  });

  it("with several checkouts for one customer, each id returns ITS OWN cart (not the newest or an arbitrary one)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead();
      const older = await w.checkout(l.id, delivery({ items: [{ product_id: "222", sku: "GUM-30", name: "Sleep Gummies", price: "500", quantity: 1 }], shipping_address: { ...ADDRESS, city: "Mumbai", zip: "400001" } }));
      const newer = await w.checkout(l.id, delivery({ items: [{ product_id: "111", variant_id: "1001", name: "Herbal Tea", price: "449", quantity: 4 }], shipping_address: { ...ADDRESS, city: "Pune" } }));
      const po = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), older.id);
      const pn = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), newer.id);
      assert.deepEqual(po.lines.map((x) => [x.name, x.quantity]), [["Sleep Gummies", 1]]);
      assert.equal(po.address?.city, "Mumbai");
      assert.deepEqual(pn.lines.map((x) => [x.name, x.quantity]), [["Herbal Tea", 4]]);
      assert.equal(pn.address?.city, "Pune");
    });
  });

  it("a stale cart is flagged with its last-updated date (it cannot be refreshed from the checkout platform)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead();
      const c = await w.checkout(l.id, delivery({ updated_at: "2026-09-01 10:00:00" }));
      const p = await w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), c.id);
      assert.equal(p.stale, true);
      assert.equal(p.refreshSupported, false);
      assert.ok(p.notes.some((n) => /last updated 2026-09-01/.test(n)));
    });
  });

  it("authorization: a salesperson sees the prefill only for a lead they own; anyone else gets 'not found'", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead();
      const c = await w.checkout(l.id, delivery());
      assert.equal((await w.svc.getOrderPrefill(as(w.rep, Role.SALESPERSON), c.id)).abandonmentId, c.id);
      await assert.rejects(() => w.svc.getOrderPrefill(as(w.otherRep, Role.SALESPERSON), c.id), (e: any) => e.statusCode === 404);
      await assert.rejects(() => w.svc.getOrderPrefill(as(w.admin, Role.ADMIN), uid()), (e: any) => e.statusCode === 404);
    });
  });

  it("the list/detail APIs do not expose the saved address (it is only returned by the scoped order-prefill endpoint)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead();
      const c = await w.checkout(l.id, delivery());
      const detail = await w.svc.getAbandonment(as(w.admin, Role.ADMIN), c.id);
      const text = JSON.stringify(detail.cartSnapshot);
      assert.ok(!text.includes("Rose Villa") && !text.includes("411001"), text.slice(0, 200));
    });
  });
});

describe("a repeat delivery for the same cart refreshes what it carries and keeps what it lacks", () => {
  it("a later delivery without an address does not erase the earlier address (and a newer one replaces it)", () => {
    const first = buildCartSnapshot(parseAbandonmentEvent(delivery({ cart_id: "c1" }))!);
    const noAddress = buildCartSnapshot(parseAbandonmentEvent(delivery({ cart_id: "c1", shipping_address: null, billing_address: null, items: [] }))!, first) as any;
    assert.equal(noAddress.shippingAddress.city, "Pune", "kept");
    assert.equal(noAddress.lines.length, 2, "the earlier lines are kept when the repeat has none");
    const moved = buildCartSnapshot(parseAbandonmentEvent(delivery({ cart_id: "c1", shipping_address: { ...ADDRESS, city: "Nagpur" } }))!, first) as any;
    assert.equal(moved.shippingAddress.city, "Nagpur", "replaced by the newer one");
  });
});

describe("creating the order from the prefilled checkout", () => {
  const create = (w: Awaited<ReturnType<typeof world>>, over: Record<string, unknown> = {}) =>
    w.orders.createManualOrder(as(w.rep, Role.SALESPERSON), { leadId: "", items: [], ...w.base, ...over } as never);

  it("the order keeps the salesperson's edits (quantity, address) and is traceable to the checkout", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead();
      const c = await w.checkout(l.id, delivery());
      const edited = { ...w.base.shippingAddress, line1: "99 Edited Street", pincode: "411002" };
      const r = await create(w, { leadId: l.id, abandonmentId: c.id, items: [{ productId: w.tea.id, variantId: w.teaVariant.id, quantity: 3, unitPrice: "449.00" }, { productId: w.gum.id, quantity: 1, unitPrice: "500.00" }], shippingAddress: edited });
      assert.equal(r.order.items.length, 2);
      assert.equal(r.order.items.find((i: any) => i.productId === w.tea.id)!.quantity, 3, "the edited quantity, not the website's 2");
      const row = await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { shippingAddress: true, shippingPincode: true, leadId: true, totalAmount: true, metadata: true } });
      assert.equal((row.shippingAddress as any).line1, "99 Edited Street");
      assert.equal(row.shippingPincode, "411002");
      assert.equal(row.leadId, l.id);
      assert.equal(row.totalAmount.toString(), "1897", "3 x 449 + 500 + the flat COD shipping of 50, computed by the server");
      assert.deepEqual((row.metadata as any).abandonment, { id: c.id, referenceId: c.referenceId });
      const act = await tx.activity.findFirstOrThrow({ where: { orderId: r.order.id, type: "ORDER_CREATED" } });
      assert.match(act.description ?? "", /abandoned checkout/i);
    });
  });

  it("another customer's checkout, an unknown checkout, and an unauthorized lead are all rejected; nothing is created", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const mine = await w.lead();
      const theirs = await w.lead();
      const theirCheckout = await w.checkout(theirs.id, delivery({ phone_number: "9111111111" }));
      const items = [{ productId: w.gum.id, quantity: 1, unitPrice: "500.00" }];
      await assert.rejects(() => create(w, { leadId: mine.id, abandonmentId: theirCheckout.id, items }), (e: any) => e.statusCode === 404);
      await assert.rejects(() => create(w, { leadId: mine.id, abandonmentId: uid(), items }), (e: any) => e.statusCode === 404);
      const foreignLead = await w.lead({ ownerId: w.otherRep.id });
      const foreignCheckout = await w.checkout(foreignLead.id, delivery());
      await assert.rejects(() => create(w, { leadId: foreignLead.id, abandonmentId: foreignCheckout.id, items }), (e: any) => e.statusCode === 404, "a lead the salesperson cannot see");
      assert.equal(await tx.order.count({ where: { leadId: { in: [mine.id, foreignLead.id] } } }), 0);
    });
  });

  it("invalid product, variant, quantity, price and checkout-id shapes are rejected by validation", () => {
    const ok = { leadId: uid(), abandonmentId: uid(), paymentMethod: "COD", items: [{ productId: uid(), quantity: 1, unitPrice: "10.00" }], shippingAddress: { line1: "1 St", city: "Pune", state: "MH", pincode: "411001" } };
    assert.ifError(validateCreateManualOrder(ok).error);
    assert.ok(validateCreateManualOrder({ ...ok, abandonmentId: "not-a-uuid" }).error, "bad checkout id");
    assert.ok(validateCreateManualOrder({ ...ok, items: [{ ...ok.items[0], productId: "nope" }] }).error, "bad product id");
    assert.ok(validateCreateManualOrder({ ...ok, items: [{ ...ok.items[0], variantId: "nope" }] }).error, "bad variant id");
    assert.ok(validateCreateManualOrder({ ...ok, items: [{ ...ok.items[0], quantity: 0 }] }).error, "zero quantity");
    assert.ok(validateCreateManualOrder({ ...ok, items: [{ ...ok.items[0], quantity: 1.5 }] }).error, "fractional quantity");
    assert.ok(validateCreateManualOrder({ ...ok, items: [{ ...ok.items[0], unitPrice: "-5" }] }).error, "negative price");
    assert.ok(validateCreateManualOrder({ ...ok, shippingAddress: { ...ok.shippingAddress, pincode: "12" } }).error, "bad pincode");
  });

  it("a real unknown product / variant for the abandoned checkout is refused by the existing server-side checks", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead();
      const c = await w.checkout(l.id, delivery());
      await assert.rejects(() => create(w, { leadId: l.id, abandonmentId: c.id, items: [{ productId: uid(), quantity: 1, unitPrice: "1.00" }] }), (e: any) => e.statusCode === 400);
      await assert.rejects(() => create(w, { leadId: l.id, abandonmentId: c.id, items: [{ productId: w.gum.id, variantId: w.teaVariant.id, quantity: 1, unitPrice: "1.00" }] }), (e: any) => e.statusCode === 400);
      assert.equal(await tx.order.count({ where: { leadId: l.id } }), 0);
    });
  });

  it("a double submit with the same idempotency key creates ONE order and ONE Shopify order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead();
      const c = await w.checkout(l.id, delivery());
      const input = { leadId: l.id, abandonmentId: c.id, idempotencyKey: `idem-${uid()}`, items: [{ productId: w.gum.id, quantity: 1, unitPrice: "500.00" }] };
      const [a, b] = await Promise.all([create(w, input), create(w, input)]);
      assert.equal(a.order.id, b.order.id);
      assert.equal(await tx.order.count({ where: { leadId: l.id } }), 1);
      assert.equal(w.shop.creates(), 1);
    });
  });

  it("Shopify down at creation: the CRM order and its checkout link survive; the retry links ONE Shopify order and keeps the relationship", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      let down = true;
      const shop = fakeShopify(async () => { if (down) throw new ShopifyApiError("Could not reach the store (test)"); return DEFAULT_CREATE_RESPONSE; });
      const orders = new OrdersService(tx as never, () => shop.client);
      const l = await w.lead();
      const c = await w.checkout(l.id, delivery());
      const first = await orders.createManualOrder(as(w.rep, Role.SALESPERSON), { leadId: l.id, abandonmentId: c.id, ...w.base, items: [{ productId: w.gum.id, quantity: 1, unitPrice: "500.00" }] } as never);
      assert.equal(first.shopify.status, "failed", "reported, never hidden");
      const afterFail = await tx.order.findUniqueOrThrow({ where: { id: first.order.id }, select: { externalId: true, metadata: true } });
      assert.equal(afterFail.externalId, null);
      assert.deepEqual((afterFail.metadata as any).abandonment, { id: c.id, referenceId: c.referenceId });
      down = false;
      const retried = await orders.pushOrderToShopify(as(w.rep, Role.SALESPERSON), first.order.id);
      assert.equal(retried.status, "created");
      const linked = await tx.order.findUniqueOrThrow({ where: { id: first.order.id }, select: { externalId: true, metadata: true } });
      assert.ok(linked.externalId);
      assert.deepEqual((linked.metadata as any).abandonment, { id: c.id, referenceId: c.referenceId }, "still tied to the original checkout after the retry");
      assert.equal((await orders.pushOrderToShopify(as(w.rep, Role.SALESPERSON), first.order.id)).status, "already_linked", "a further retry never creates a second Shopify order");
      assert.equal(await tx.order.count({ where: { leadId: l.id } }), 1);
    });
  });
});
