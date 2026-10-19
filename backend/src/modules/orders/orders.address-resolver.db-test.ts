// The Create Order address prefill: which address is offered for the selected customer, and that what is saved is exactly what was entered. ONE rolled-back transaction on the isolated
// test database; synthetic data; Shopify is a fake and never called. Run via the guarded isolated-DB runner only.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AbandonmentStatus, AbandonmentType, ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
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
const PHONE = "+919811700001";

async function world(tx: Prisma.TransactionClient) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const as = { id: admin.id, username: admin.username, role: Role.ADMIN };
  const lead = (first: string, over: Partial<Prisma.LeadUncheckedCreateInput> = {}) =>
    tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: first, mobile: PHONE.slice(3), normalizedMobile: PHONE, ...over }, select: { id: true } });
  const order = (leadId: string, shippingAddress: unknown, over: Partial<Prisma.OrderUncheckedCreateInput> = {}) =>
    tx.order.create({ data: { orderNumber: `O-${uid()}`, leadId, source: "SALESPERSON", status: "CONFIRMED", totalAmount: "10.00", shippingAddress: shippingAddress as Prisma.InputJsonValue, ...over }, select: { id: true } });
  const checkout = async (leadId: string, snapshot: unknown) => {
    const source = await tx.source.upsert({ where: { code: "chk-addr" }, update: {}, create: { name: "Checkout addr", code: "chk-addr" } });
    return tx.abandonment.create({ data: { leadId, type: AbandonmentType.CHECKOUT, sourceId: source.id, referenceType: "ShiprocketCheckoutCart", referenceId: `cart-${uid()}`, detectedAt: new Date(), status: AbandonmentStatus.ACTIVE, cartSnapshot: snapshot as Prisma.InputJsonValue }, select: { id: true } });
  };
  return { as, lead, order, checkout, svc: new OrdersService(tx) };
}
const addr = (over: Record<string, unknown> = {}) => ({ name: "Asha Rao", line1: "12 MG Road", line2: "Near Station", city: "Pune", state: "Maharashtra", pincode: "411001", phone: "9811700001", ...over });

describe("Create Order address prefill - which address is offered", () => {
  it("the selected customer's own latest order address is offered", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("Asha");
      await w.order(l.id, addr({ line1: "Old Road", city: "Thane" }), { createdAt: new Date(Date.now() - 86_400_000) });
      await w.order(l.id, addr());
      const r = await w.svc.getLastShippingAddress(w.as, l.id);
      assert.equal(r.address?.line1, "12 MG Road");
      assert.equal(r.source, "ORDER");
    });
  });

  it("a customer with no order yet gets the address they typed at checkout (nested provider shape, field aliases, landmark and instructions kept)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("Shiprocket Checkout Lead");
      await w.checkout(l.id, { shippingAddress: { address: { address_line_1: "Tower 3, Flat 904", locality: "Powai", landmark: "Opp. metro", delivery_instructions: "Leave with security", city: "Mumbai", state: "Maharashtra", postal_code: "400076", phone: "9811700001" } } });
      const r = await w.svc.getLastShippingAddress(w.as, l.id);
      assert.equal(r.source, "CHECKOUT");
      assert.deepEqual([r.address?.line1, r.address?.area, r.address?.landmark, r.address?.deliveryInstructions, r.address?.city, r.address?.pincode], ["Tower 3, Flat 904", "Powai", "Opp. metro", "Leave with security", "Mumbai", "400076"]);
    });
  });

  it("a map-style place description is never copied into pincode or city", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("Asha");
      const maps = "Near Phoenix Mall, Lower Parel, Mumbai, Maharashtra 400013, India";
      await w.order(l.id, { name: "Asha", line1: "Shop 5", city: maps, state: "Maharashtra", pincode: maps }, { shippingPincode: "400013" });
      const r = await w.svc.getLastShippingAddress(w.as, l.id);
      assert.deepEqual([r.address?.city, r.address?.pincode], ["", "400013"], "the order's own valid shippingPincode is used; the description is not");
    });
  });

  it("a DIFFERENT customer sharing the phone number never supplies the address", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const mine = await w.lead("Asha");
      const other = await w.lead("Vikram");
      await w.order(other.id, addr({ name: "Vikram", line1: "99 Other Street" }));
      assert.equal((await w.svc.getLastShippingAddress(w.as, mine.id)).address, null);
      assert.equal((await w.svc.getLastShippingAddress(w.as, other.id)).address?.line1, "99 Other Street");
    });
  });

  it("the SAME person's other lead record (placeholder name, same phone) is used when the selected lead has nothing", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const selected = await w.lead("Shiprocket Checkout Lead");
      const earlier = await w.lead("Asha");
      await w.order(earlier.id, addr());
      const r = await w.svc.getLastShippingAddress(w.as, selected.id);
      assert.equal(r.address?.line1, "12 MG Road");
    });
  });

  it("nothing saved anywhere -> null (the form stays empty for manual entry)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("Asha");
      assert.deepEqual(await w.svc.getLastShippingAddress(w.as, l.id), { address: null, source: null });
    });
  });
});

describe("Create Order saves exactly the address that was entered", () => {
  it("an edited address (with landmark and delivery instructions) is stored as typed, not replaced by the prefill", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("Asha");
      await w.order(l.id, addr({ line1: "Old Road", city: "Thane", pincode: "400601" }));
      const product = await tx.product.create({ data: { name: "Tea", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "100.00" }, select: { id: true } });
      const shopify = { query: async (doc: string) => (/orderCreate/.test(doc) ? { orderCreate: { order: { id: "gid://shopify/Order/1", name: "#T1" }, userErrors: [] } } : { order: { id: "gid://shopify/Order/1", tags: [] }, tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } }) } as unknown as ShopifyClient;
      const svc = new OrdersService(tx, () => shopify);
      const typed = { name: "Asha Rao", line1: "Flat 7, Green Heights", line2: "Baner Road, Baner, Near Garden", houseNumber: "Flat 7", building: "Green Heights", area: "Baner", street: "Baner Road", landmark: "Near Garden", deliveryInstructions: "Call before delivery", city: "Pune", state: "Maharashtra", pincode: "411045", addressType: "HOME" as const, phone: "9811700001" };
      const created = await svc.createManualOrder(w.as, { leadId: l.id, items: [{ productId: product.id, quantity: 1, unitPrice: "100.00" }], paymentMethod: "COD", shippingAddress: typed, shippingPincode: "411045" });
      const saved = created.order.shippingAddress as Record<string, string> | null;
      assert.deepEqual([saved?.line1, saved?.landmark, saved?.deliveryInstructions, saved?.city, saved?.pincode], ["Flat 7, Green Heights", "Near Garden", "Call before delivery", "Pune", "411045"]);
      const stored = await tx.order.findUniqueOrThrow({ where: { id: created.order.id }, select: { shippingPincode: true } });
      assert.equal(stored.shippingPincode, "411045");
    });
  });
});
