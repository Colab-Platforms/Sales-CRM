// Editing an existing order: change a line's flavour / the delivery address, through the REAL OrderEditService. ONE rolled-back transaction on the isolated test database; synthetic data; Shopify is a stateful
// fake that follows the real call sequence (read order -> order edit begin / set quantity / add variant / commit; orderUpdate) - nothing reaches Shopify.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { OrderStatus, ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import OrderEditService from "./orders.edit.service.js";
import { ShopifyApiError } from "../shopify/shopify.client.js";
import { readEditableOrder } from "../shopify/shopify.orders.edit.js";
import { validateUpdateShippingAddress } from "./orders.validators.js";

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
const num = () => String(Math.floor(1e8 + Math.random() * 9e8));

interface FakeOpts {
  fulfillment?: string;
  cancelled?: boolean;
  /** the new variant's price in Shopify */
  newPrice?: string;
  failCommit?: boolean;
  failAddress?: boolean;
  /** Shopify already holds the NEW variant (a repeat of a change that half-succeeded) */
  alreadySwapped?: boolean;
  /** orderUpdate answers OK but does not keep the address */
  addressNotSaved?: boolean;
  /** orderUpdate keeps the address but drops the province */
  provinceDropped?: boolean;
  /** every Shopify call waits this long (lets two requests overlap) */
  delayMs?: number;
  /** orderEditCommit answers OK but the order is not changed */
  commitNoop?: boolean;
  /** the first N reads after the commit still show the order as it was before it (read-after-write lag) */
  staleReads?: number;
  /** the first N reads after the commit fail (a dropped connection) */
  readFailsAfterCommit?: number;
}

function fakeShopify(w: { oldGid: string; newGid: string; productGid: string; otherProductGid?: string }, opts: FakeOpts = {}) {
  const calls: string[] = [];
  const state = {
    total: "1298.00",
    lines: [{ id: "gid://shopify/LineItem/1", quantity: 2, current: undefined as number | undefined, variant: opts.alreadySwapped ? w.newGid : w.oldGid, price: "649.00" }],
    committed: false,
    snapshot: null as any,
    newId: 100,
    staleLeft: opts.staleReads ?? 0,
    failsLeft: opts.readFailsAfterCommit ?? 0,
    shipping: { firstName: "Old", lastName: "Name", address1: "Old line", address2: null, city: "Pune", provinceCode: "MH", zip: "411001", countryCodeV2: "IN", phone: null } as Record<string, string | null>,
    updatedInput: null as any,
    stagedLines: null as any,
  };
  const client = {
    query: async (doc: string, vars: any) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (/crmOrderForEdit/.test(doc)) {
        calls.push("read_order");
        if (state.committed && state.failsLeft > 0) { state.failsLeft -= 1; throw new ShopifyApiError("socket hang up", 502); }
        let view = state.lines;
        if (state.committed && state.staleLeft > 0) { state.staleLeft -= 1; view = state.snapshot; }
        return { order: { id: "gid://shopify/Order/1", cancelledAt: opts.cancelled ? "2026-10-20T00:00:00Z" : null, displayFulfillmentStatus: opts.fulfillment ?? "UNFULFILLED", currentTotalPriceSet: { shopMoney: { amount: state.total } },
          lineItems: { nodes: view.map((l: any) => ({ id: l.id, quantity: l.quantity, currentQuantity: l.current ?? l.quantity, variant: { id: l.variant, product: { id: w.productGid } }, originalUnitPriceSet: { shopMoney: { amount: l.price } } })) }, shippingAddress: state.shipping } };
      }
      if (/crmVariantForEdit/.test(doc)) { calls.push("read_variant"); return { productVariant: { id: vars.id, price: opts.newPrice ?? "649.00", product: { id: vars.id === w.newGid ? w.productGid : w.otherProductGid ?? w.productGid } } }; }
      if (/crmFlavourEditBegin/.test(doc)) {
        calls.push("edit_begin");
        state.stagedLines = state.lines.map((l) => ({ ...l }));
        return { orderEditBegin: { calculatedOrder: { id: "gid://shopify/CalculatedOrder/9", lineItems: { nodes: state.lines.filter((l) => (l.current ?? l.quantity) > 0).map((l, i) => ({ id: `gid://shopify/CalculatedLineItem/${i}`, quantity: l.current ?? l.quantity, variant: { id: l.variant } })) } }, userErrors: [] } };
      }
      if (/crmFlavourEditSetQuantity/.test(doc)) { calls.push("edit_set_quantity"); for (const l of state.stagedLines) if ((l.current ?? l.quantity) > 0) l.current = 0; /* Shopify keeps the removed line: quantity stays, currentQuantity becomes 0 */ return { orderEditSetQuantity: { calculatedOrder: { id: "x", totalPriceSet: { shopMoney: { amount: "0.00" } } }, userErrors: [] } }; }
      if (/crmFlavourEditAddVariant/.test(doc)) {
        calls.push("edit_add_variant");
        const price = opts.newPrice ?? "649.00";
        state.stagedLines.push({ id: `gid://shopify/LineItem/${state.newId++}`, quantity: vars.quantity, variant: vars.variantId, price });
        const staged = (Number(price) * vars.quantity).toFixed(2);
        return { orderEditAddVariant: { calculatedOrder: { id: "x", totalPriceSet: { shopMoney: { amount: staged } } }, userErrors: [] } };
      }
      if (/crmFlavourEditCommit/.test(doc)) {
        calls.push("edit_commit");
        if (opts.failCommit) return { orderEditCommit: { order: null, userErrors: [{ field: null, message: "Access denied for orderEditCommit field" }] } };
        if (opts.commitNoop) return { orderEditCommit: { order: { id: "gid://shopify/Order/1" }, userErrors: [] } };
        state.snapshot = state.lines;
        state.lines = state.stagedLines;
        state.committed = true;
        state.total = state.lines.reduce((s: number, l: any) => s + Number(l.price) * (l.current ?? l.quantity), 0).toFixed(2);
        return { orderEditCommit: { order: { id: "gid://shopify/Order/1" }, userErrors: [] } };
      }
      if (/crmOrderShippingAddressUpdate/.test(doc)) {
        calls.push("address_update");
        state.updatedInput = vars.input;
        if (opts.failAddress) return { orderUpdate: { order: null, userErrors: [{ field: ["shippingAddress"], message: "Enter a last name" }] } };
        if (!opts.addressNotSaved) state.shipping = { ...state.shipping, ...vars.input.shippingAddress, ...(opts.provinceDropped ? { provinceCode: null } : {}) };
        return { orderUpdate: { order: { id: vars.input.id }, userErrors: [] } };
      }
      throw new Error(`unexpected Shopify call: ${doc.slice(0, 60)}`);
    },
  };
  return { client, calls, state };
}

async function world(tx: Prisma.TransactionClient, over: { linked?: boolean; status?: OrderStatus; shipment?: boolean; newVariantPrice?: string } = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const asha = await tx.user.create({ data: { name: "Asha", username: `t1-${uid()}`, role: Role.SALESPERSON } });
  const bala = await tx.user.create({ data: { name: "Bala", username: `t2-${uid()}`, role: Role.SALESPERSON } });
  const hr = await tx.user.create({ data: { name: "HR", username: `h-${uid()}`, role: Role.HR } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Meera", lastName: "Rao", mobile: "9811900001", normalizedMobile: "+919811900001", ownerId: asha.id } });
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "649.00", externalSource: "SHOPIFY", externalId: num() } });
  const other = await tx.product.create({ data: { name: "Other Product", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "649.00" } });
  const mk = (productId: string, name: string, price: string, linked = true) => tx.productVariant.create({ data: { productId, name, price, sku: `V-${uid().slice(0, 6)}`, ...(linked ? { externalId: num(), externalSource: "SHOPIFY" as const } : {}) } });
  const gutka = await mk(product.id, "Gutka Flavour", "649.00");
  const paan = await mk(product.id, "Paan Masala Flavour", over.newVariantPrice ?? "649.00");
  const foreign = await mk(other.id, "Foreign Flavour", "649.00");
  const order = await tx.order.create({
    data: {
      orderNumber: `CRM-${uid().slice(0, 8)}`, leadId: lead.id, source: "SALESPERSON", status: over.status ?? "CONFIRMED", subtotal: "1298.00", discountAmount: "0.00", shippingAmount: "0.00", taxAmount: "0.00", totalAmount: "1298.00",
      createdById: asha.id, shippingPincode: "411001", shippingAddress: { name: "Meera Rao", line1: "Old line", city: "Pune", state: "Maharashtra", pincode: "411001", landmark: "Near park", houseNumber: "Flat 7", building: "Green Heights", area: "Baner", street: "Baner Road" } as Prisma.InputJsonValue,
      ...(over.linked === false ? {} : { externalSource: "SHOPIFY" as const, externalId: "1", externalNumber: "#1001" }),
      items: { create: [{ productId: product.id, variantId: gutka.id, productNameSnapshot: "Herbal Masala", variantNameSnapshot: "Gutka Flavour", skuSnapshot: gutka.sku, quantity: 2, unitPrice: "649.00", totalPrice: "1298.00" }] },
      ...(over.shipment ? { shipments: { create: { status: "SHIPPED" } } } : {}),
    },
    select: { id: true, items: { select: { id: true } } },
  });
  const gid = (v: { externalId: string | null }) => `gid://shopify/ProductVariant/${v.externalId}`;
  const ids = { oldGid: gid(gutka), newGid: gid(paan), productGid: `gid://shopify/Product/${product.externalId}`, otherProductGid: "gid://shopify/Product/999" };
  const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });
  return { admin, asha, bala, hr, order, itemId: order.items[0]!.id, gutka, paan, foreign, ids, as };
}

const svc = (tx: Prisma.TransactionClient, f: ReturnType<typeof fakeShopify>) => new OrderEditService(tx as never, () => f.client as never);
const read = (tx: Prisma.TransactionClient, id: string) => tx.order.findUniqueOrThrow({ where: { id }, include: { items: true } });

describe("change flavour", () => {
  it("a telecaller switches a flavour: Shopify is edited with the supported sequence, its total is unchanged, the CRM line follows, and the change is audited", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(w.ids);
      const r = await svc(tx, f).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id);
      assert.equal(r.shopify, "updated");
      assert.deepEqual(f.calls.filter((c) => c.startsWith("edit_")), ["edit_begin", "edit_set_quantity", "edit_add_variant", "edit_commit"]);
      const active = f.state.lines.filter((l) => (l.current ?? l.quantity) > 0);
      assert.deepEqual(active.map((l) => [l.variant, l.quantity]), [[w.ids.newGid, 2]], "Shopify's active lines: only the new variant, quantity kept");
      assert.equal(f.state.lines.length, 2, "Shopify kept the removed line (quantity 2, currentQuantity 0) next to the new one - this is what the old check mistook for 'still the old flavour'");
      assert.equal(f.state.total, "1298.00", "Shopify total unchanged");
      const after = await read(tx, w.order.id);
      assert.equal(after.items[0]!.variantId, w.paan.id);
      assert.equal(after.items[0]!.variantNameSnapshot, "Paan Masala Flavour");
      assert.equal(after.totalAmount.toString(), "1298", "CRM total unchanged");
      assert.equal(after.items[0]!.unitPrice.toString(), "649");
      const audit = await tx.activity.findMany({ where: { orderId: w.order.id } });
      assert.equal(audit.length, 1);
      assert.match(audit[0]!.title ?? "", /Flavour changed/);
    });
  });

  it("a flavour with a different price is refused with an explanation: nothing is edited in Shopify or the CRM, and no payment is touched", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { newVariantPrice: "699.00" });
      const f = fakeShopify(w.ids);
      await assert.rejects(svc(tx, f).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id), (e: any) => e.statusCode === 409 && /priced differently/.test(e.message) && /extra payment or a refund/.test(e.message));
      assert.deepEqual(f.calls, []);
      assert.equal((await read(tx, w.order.id)).items[0]!.variantId, w.gutka.id);
    });
  });

  it("if Shopify's own price for the new flavour differs from the line, the swap is refused before anything is edited", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(w.ids, { newPrice: "700.00" });
      await assert.rejects(svc(tx, f).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id), (e: any) => e.statusCode === 409 && /Shopify prices the new flavour/.test(e.message));
      assert.ok(!f.calls.includes("edit_begin"));
      assert.equal((await read(tx, w.order.id)).items[0]!.variantId, w.gutka.id);
    });
  });

  it("Shopify rejecting the edit is reported as an error and the CRM is NOT changed (the two never silently disagree)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(w.ids, { failCommit: true });
      await assert.rejects(svc(tx, f).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id), (e: any) => e.statusCode === 502 && /Shopify did not change the flavour/.test(e.message) && /missing the order-editing permission/.test(e.message));
      const after = await read(tx, w.order.id);
      assert.equal(after.items[0]!.variantId, w.gutka.id);
      assert.equal(await tx.activity.count({ where: { orderId: w.order.id } }), 0);
      assert.equal(f.state.lines.filter((l) => (l.current ?? l.quantity) > 0)[0]!.variant, w.ids.oldGid, "Shopify unchanged");
    });
  });

  it("not editable: fulfilled in Shopify, cancelled in Shopify, shipped or shipment created in the CRM, a variant of another product", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const fulfilled = fakeShopify(w.ids, { fulfillment: "FULFILLED" });
      await assert.rejects(svc(tx, fulfilled).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id), (e: any) => e.statusCode === 409 && /fulfilled/.test(e.message));
      const cancelled = fakeShopify(w.ids, { cancelled: true });
      await assert.rejects(svc(tx, cancelled).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id), (e: any) => /cancelled in Shopify/.test(e.message));
      await assert.rejects(svc(tx, fakeShopify(w.ids)).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.foreign.id), (e: any) => e.statusCode === 400);
      assert.ok(![...fulfilled.calls, ...cancelled.calls].includes("edit_begin"));
    });
    await inRollback(async (tx) => {
      const w = await world(tx, { shipment: true });
      await assert.rejects(svc(tx, fakeShopify(w.ids)).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id), (e: any) => /shipment has already been created/.test(e.message));
    });
    await inRollback(async (tx) => {
      const w = await world(tx, { status: OrderStatus.DELIVERED });
      await assert.rejects(svc(tx, fakeShopify(w.ids)).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id), (e: any) => /can no longer be changed/.test(e.message));
    });
  });

  it("repeating a change Shopify already holds finishes only the CRM side - no second edit, no duplicate", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(w.ids, { alreadySwapped: true });
      const r = await svc(tx, f).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id);
      assert.equal(r.shopify, "already_applied");
      assert.ok(!f.calls.includes("edit_begin"));
      assert.equal((await read(tx, w.order.id)).items[0]!.variantId, w.paan.id);
      const again = await svc(tx, f).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id);
      assert.match(again.message, /already has that flavour/);
      assert.equal(await tx.activity.count({ where: { orderId: w.order.id } }), 1, "audited once");
    });
  });

  it("an order not linked to Shopify is changed in the CRM only, and the listing offers only same-price active flavours of the product", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { linked: false });
      const f = fakeShopify(w.ids);
      const listing = await svc(tx, f).listFlavours(w.as(w.asha, Role.SALESPERSON), w.order.id);
      assert.equal(listing.editable, true);
      assert.deepEqual(listing.lines[0]!.options.map((o) => [o.name, o.priceMatches, o.current]), [["Gutka Flavour", true, true], ["Paan Masala Flavour", true, false]]);
      const r = await svc(tx, f).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id);
      assert.equal(r.shopify, "not_linked");
      assert.deepEqual(f.calls, []);
      assert.equal((await read(tx, w.order.id)).items[0]!.variantId, w.paan.id);
    });
  });

  it("scope: another telecaller cannot edit the order, HR is refused, Admin can", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await assert.rejects(svc(tx, fakeShopify(w.ids)).changeFlavour(w.as(w.bala, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id), (e: any) => e.statusCode === 404);
      await assert.rejects(svc(tx, fakeShopify(w.ids)).changeFlavour(w.as(w.hr, Role.HR), w.order.id, w.itemId, w.paan.id), (e: any) => e.statusCode === 403);
      const r = await svc(tx, fakeShopify(w.ids)).changeFlavour(w.as(w.admin, Role.ADMIN), w.order.id, w.itemId, w.paan.id);
      assert.equal(r.shopify, "updated");
    });
  });
});

describe("edit delivery address", () => {
  const body = { name: "Meera Rao", line1: "Flat 9, New Heights", line2: "Baner Road", city: "Pune", state: "Maharashtra", pincode: "411045", phone: "9811900001" };

  it("updates Shopify's shipping address (not the billing address) and the CRM; the CRM address equals what Shopify returns; unedited details are kept; audited", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(w.ids);
      const r = await svc(tx, f).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, body);
      assert.equal(r.shopify, "updated");
      assert.equal(f.state.updatedInput.billingAddress, undefined, "billing address is not part of the update");
      const sent = f.state.updatedInput.shippingAddress;
      assert.deepEqual({ firstName: sent.firstName, lastName: sent.lastName, address1: sent.address1, city: sent.city, provinceCode: sent.provinceCode, zip: sent.zip, countryCode: sent.countryCode }, { firstName: "Meera", lastName: "Rao", address1: "Flat 9, New Heights", city: "Pune", provinceCode: "MH", zip: "411045", countryCode: "IN" });
      const stored = await tx.order.findUniqueOrThrow({ where: { id: w.order.id }, select: { shippingAddress: true, shippingPincode: true } });
      const crm = stored.shippingAddress as Record<string, string>;
      assert.equal(crm.line1, f.state.shipping.address1, "CRM address1 == Shopify address1");
      assert.equal(crm.city, f.state.shipping.city);
      assert.equal(crm.pincode, f.state.shipping.zip);
      assert.equal(stored.shippingPincode, "411045");
      assert.equal(crm.landmark, "Near park", "a detail the form did not edit is kept");
      assert.equal(await tx.activity.count({ where: { orderId: w.order.id } }), 1);
    });
  });

  it("Shopify refusing the address leaves the CRM unchanged and says so; an update Shopify does not keep is caught by the read-back", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await assert.rejects(svc(tx, fakeShopify(w.ids, { failAddress: true })).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, body), (e: any) => e.statusCode === 502 && /Enter a last name/.test(e.message) && /Nothing was changed in the CRM/.test(e.message));
      await assert.rejects(svc(tx, fakeShopify(w.ids, { addressNotSaved: true })).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, body), (e: any) => e.statusCode === 502 && /does not show the new address/.test(e.message));
      const stored = await tx.order.findUniqueOrThrow({ where: { id: w.order.id }, select: { shippingAddress: true } });
      assert.equal((stored.shippingAddress as Record<string, string>).line1, "Old line");
      assert.equal(await tx.activity.count({ where: { orderId: w.order.id } }), 0);
    });
  });

  it("blocked once a shipment exists (the courier must be corrected separately), or when Shopify shows the order fulfilled; an unlinked order is CRM-only", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { shipment: true });
      await assert.rejects(svc(tx, fakeShopify(w.ids)).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, body), (e: any) => e.statusCode === 409 && /Shiprocket\) separately/.test(e.message));
    });
    await inRollback(async (tx) => {
      const w = await world(tx);
      await assert.rejects(svc(tx, fakeShopify(w.ids, { fulfillment: "PARTIALLY_FULFILLED" })).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, body), (e: any) => /partially fulfilled/.test(e.message));
    });
    await inRollback(async (tx) => {
      const w = await world(tx, { linked: false });
      const f = fakeShopify(w.ids);
      const r = await svc(tx, f).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, body);
      assert.equal(r.shopify, "not_linked");
      assert.deepEqual(f.calls, []);
    });
  });

  it("validation reuses the order form's rules: a missing city or a bad PIN code is rejected, a valid address passes", () => {
    assert.ok(validateUpdateShippingAddress({ ...body, pincode: "12" }).error);
    assert.ok(validateUpdateShippingAddress({ ...body, city: "" }).error);
    assert.ok(validateUpdateShippingAddress({ ...body, state: undefined }).error);
    assert.ifError(validateUpdateShippingAddress(body).error);
  });
});

describe("edit address - stale parts, state validation", () => {
  const body = { name: "Meera Rao", line1: "Flat 9, New Heights", line2: "Baner Road", city: "Pune", state: "Maharashtra", pincode: "411045", phone: "9811900001" };
  const stored = async (tx: Prisma.TransactionClient, id: string) => (await tx.order.findUniqueOrThrow({ where: { id }, select: { shippingAddress: true } })).shippingAddress as Record<string, string>;

  it("editing the address lines drops the old house number / building / area / street (they cannot reappear on the next order form); landmark and the rest are kept", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await svc(tx, fakeShopify(w.ids)).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, body);
      const a = await stored(tx, w.order.id);
      for (const key of ["houseNumber", "building", "area", "street"]) assert.equal(a[key], undefined, key);
      assert.equal(a.line1, "Flat 9, New Heights");
      assert.equal(a.landmark, "Near park");
    });
  });

  it("an edit that leaves the lines alone (phone / name) keeps the structured parts; supplying them replaces them", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await svc(tx, fakeShopify(w.ids)).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, { ...body, line1: "Old line", line2: undefined, phone: "9000000002" });
      let a = await stored(tx, w.order.id);
      assert.deepEqual([a.houseNumber, a.building, a.area, a.street], ["Flat 7", "Green Heights", "Baner", "Baner Road"]);
      await svc(tx, fakeShopify(w.ids)).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, { ...body, houseNumber: "Flat 12", area: "Aundh" });
      a = await stored(tx, w.order.id);
      assert.deepEqual([a.houseNumber, a.area, a.building], ["Flat 12", "Aundh", undefined]);
    });
  });

  it("an unknown state is rejected before anything is sent (linked or not); a valid one is sent as its province code and verified by the read-back", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(w.ids);
      for (const state of ["Maharastra", "XX", "Atlantis"]) {
        await assert.rejects(svc(tx, f).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, { ...body, state }), (e: any) => e.statusCode === 400 && /not a recognised Indian state/.test(e.message), state);
      }
      assert.deepEqual(f.calls, [], "nothing reached Shopify");
      assert.equal((await stored(tx, w.order.id)).line1, "Old line");
      await svc(tx, f).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, { ...body, state: "Karnataka" });
      assert.equal(f.state.updatedInput.shippingAddress.provinceCode, "KA");
      assert.equal(f.state.shipping.provinceCode, "KA");
    });
    await inRollback(async (tx) => {
      const w = await world(tx, { linked: false });
      await assert.rejects(svc(tx, fakeShopify(w.ids)).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, { ...body, state: "Nowhere" }), (e: any) => e.statusCode === 400);
    });
  });

  it("a province Shopify did not keep is caught by the read-back and the CRM stays unchanged", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await assert.rejects(svc(tx, fakeShopify(w.ids, { provinceDropped: true })).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, body), (e: any) => e.statusCode === 502 && /does not show the new address/.test(e.message));
      assert.equal((await stored(tx, w.order.id)).line1, "Old line");
    });
  });
});

describe("edit claim (one edit at a time per order)", () => {
  const claimKey = async (tx: Prisma.TransactionClient, id: string) => ((await tx.order.findUniqueOrThrow({ where: { id }, select: { metadata: true } })).metadata as Record<string, unknown> | null)?.orderEditClaimedAt;
  const addr = { name: "Meera Rao", line1: "Flat 9, New Heights", city: "Pune", state: "Maharashtra", pincode: "411045" };

  it("two overlapping flavour changes: one is applied, the other is refused with 409, Shopify is edited exactly once, audited once, and the claim is released", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(w.ids, { delayMs: 15 });
      const s = svc(tx, f);
      const results = await Promise.allSettled([
        s.changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id),
        s.changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assert.equal(refused.reason.statusCode, 409);
      assert.match(refused.reason.message, /already in progress/);
      assert.equal(f.calls.filter((c) => c === "edit_commit").length, 1, "one Shopify edit");
      assert.equal(await tx.activity.count({ where: { orderId: w.order.id } }), 1);
      assert.equal(await claimKey(tx, w.order.id), undefined, "claim released");
      assert.equal((await read(tx, w.order.id)).items[0]!.variantId, w.paan.id);
    });
  });

  it("a flavour change and an address change cannot overlap either", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const s = svc(tx, fakeShopify(w.ids, { delayMs: 15 }));
      const results = await Promise.allSettled([
        s.changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id),
        s.updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, addr),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as any).statusCode, 409);
      assert.equal(await claimKey(tx, w.order.id), undefined);
    });
  });

  it("the claim is released after a Shopify error, a validation refusal and an unexpected exception - the next attempt works", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await assert.rejects(svc(tx, fakeShopify(w.ids, { failCommit: true })).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id), (e: any) => e.statusCode === 502);
      assert.equal(await claimKey(tx, w.order.id), undefined, "released after a Shopify rejection");
      await assert.rejects(svc(tx, fakeShopify(w.ids)).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, { ...addr, state: "Nowhere" }), (e: any) => e.statusCode === 400);
      assert.equal(await claimKey(tx, w.order.id), undefined, "released after a refusal");
      const boom = { query: async () => { throw new Error("socket hang up"); } };
      await assert.rejects(new OrderEditService(tx as never, () => boom as never).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id));
      assert.equal(await claimKey(tx, w.order.id), undefined, "released after an unexpected exception");
      const ok = await svc(tx, fakeShopify(w.ids)).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id);
      assert.equal(ok.shopify, "updated");
    });
  });

  it("a claim held by a request in progress blocks (409, nothing sent to Shopify); a claim left by a dead process expires; no claim is taken for a missing / out-of-scope order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(w.ids);
      await tx.$executeRaw`UPDATE orders SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{orderEditClaimedAt}', to_jsonb(now()::text)) WHERE id = ${w.order.id}::uuid`;
      await assert.rejects(svc(tx, f).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, addr), (e: any) => e.statusCode === 409);
      assert.deepEqual(f.calls, []);
      await tx.$executeRaw`UPDATE orders SET metadata = jsonb_set(metadata, '{orderEditClaimedAt}', to_jsonb((now() - interval '10 minutes')::text)) WHERE id = ${w.order.id}::uuid`;
      const r = await svc(tx, f).updateAddress(w.as(w.asha, Role.SALESPERSON), w.order.id, addr);
      assert.equal(r.shopify, "updated");
      assert.equal(await claimKey(tx, w.order.id), undefined);
      await assert.rejects(svc(tx, f).updateAddress(w.as(w.bala, Role.SALESPERSON), w.order.id, addr), (e: any) => e.statusCode === 404);
      assert.equal(await claimKey(tx, w.order.id), undefined, "an out-of-scope request never touches the order row");
    });
  });
});

describe("flavour change - verification against Shopify's real removed-line behaviour (regression)", () => {
  const ids = (w: Awaited<ReturnType<typeof world>>) => w.ids;
  const activeOf = (f: ReturnType<typeof fakeShopify>) => f.state.lines.filter((l) => (l.current ?? l.quantity) > 0);

  it("success: Shopify keeps the removed old line (quantity 2, currentQuantity 0) and adds the new one under a NEW line-item id - the fresh read confirms the new flavour and only then is the CRM updated", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(ids(w));
      const r = await svc(tx, f).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id);
      assert.equal(r.shopify, "updated");
      const lines = f.state.lines;
      assert.deepEqual(lines.map((l) => [l.id, l.quantity, l.current ?? l.quantity]), [["gid://shopify/LineItem/1", 2, 0], ["gid://shopify/LineItem/100", 2, 2]]);
      assert.equal((await read(tx, w.order.id)).items[0]!.variantId, w.paan.id);
    });
  });

  it("Shopify accepts the edit but a fresh read still shows the OLD flavour: reported with the counts, the CRM is NOT changed, nothing is audited, and no second edit was made", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(ids(w), { commitNoop: true });
      await assert.rejects(svc(tx, f).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id), (e: any) =>
        e.statusCode === 502 && /shows 0 of the new flavour \(expected 2\) and 2 of the old one/.test(e.message) && /CRM was NOT changed/.test(e.message) && /Retrying is safe/.test(e.message));
      assert.equal((await read(tx, w.order.id)).items[0]!.variantId, w.gutka.id);
      assert.equal(await tx.activity.count({ where: { orderId: w.order.id } }), 0);
      assert.equal(f.calls.filter((c) => c === "edit_commit").length, 1);
    });
  });

  it("Shopify returns user errors on the commit: failed with the reason, Shopify and the CRM unchanged", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(ids(w), { failCommit: true });
      await assert.rejects(svc(tx, f).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id), (e: any) => e.statusCode === 502 && /Access denied/.test(e.message));
      assert.deepEqual(activeOf(f).map((l) => l.variant), [w.ids.oldGid]);
      assert.equal((await read(tx, w.order.id)).items[0]!.variantId, w.gutka.id);
    });
  });

  it("read-after-write lag: the first re-read still shows the order as it was; the verification re-reads and succeeds - no false failure, no second edit", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(ids(w), { staleReads: 1 });
      const r = await svc(tx, f).changeFlavour(w.as(w.asha, Role.SALESPERSON), w.order.id, w.itemId, w.paan.id);
      assert.equal(r.shopify, "updated");
      assert.equal(f.calls.filter((c) => c === "edit_commit").length, 1);
      assert.equal((await read(tx, w.order.id)).items[0]!.variantId, w.paan.id);
    });
  });

  it("RETRY after a committed-but-unconfirmed edit (the re-read failed): the CRM stays unchanged, then the retry sees the new flavour already on the order and only updates the CRM - exactly ONE new line, ONE commit, one audit entry", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fakeShopify(ids(w), { readFailsAfterCommit: 3 });
      const u = w.as(w.asha, Role.SALESPERSON);
      await assert.rejects(svc(tx, f).changeFlavour(u, w.order.id, w.itemId, w.paan.id), (e: any) => e.statusCode === 502 && /could not be re-read/.test(e.message) && /CRM was NOT changed/.test(e.message));
      assert.equal((await read(tx, w.order.id)).items[0]!.variantId, w.gutka.id, "CRM unchanged while Shopify could not confirm");
      assert.deepEqual(activeOf(f).map((l) => [l.variant, l.quantity]), [[w.ids.newGid, 2]], "Shopify did commit");
      f.state.failsLeft = 0; // the connection is back
      const retry = await svc(tx, f).changeFlavour(u, w.order.id, w.itemId, w.paan.id);
      assert.equal(retry.shopify, "already_applied");
      assert.equal(f.calls.filter((c) => c === "edit_commit").length, 1, "no second edit");
      assert.equal(f.calls.filter((c) => c === "edit_begin").length, 1);
      assert.equal(activeOf(f).length, 1, "no duplicate line");
      assert.equal((await read(tx, w.order.id)).items[0]!.variantId, w.paan.id);
      assert.equal(await tx.activity.count({ where: { orderId: w.order.id } }), 1);
      const again = await svc(tx, f).changeFlavour(u, w.order.id, w.itemId, w.paan.id);
      assert.match(again.message, /already has that flavour/);
      assert.equal(f.calls.filter((c) => c === "edit_commit").length, 1);
    });
  });

  it("readEditableOrder reports only the lines that are on the order: a removed line (currentQuantity 0) is left out, a partly removed one uses its current quantity, an older response without currentQuantity falls back to quantity", async () => {
    const node = (id: string, quantity: number, currentQuantity: number | undefined, variant: string) => ({ id, quantity, ...(currentQuantity === undefined ? {} : { currentQuantity }), variant: { id: variant, product: { id: "gid://shopify/Product/1" } }, originalUnitPriceSet: { shopMoney: { amount: "649.00" } } });
    const client = { query: async () => ({ order: { id: "gid://shopify/Order/1", cancelledAt: null, displayFulfillmentStatus: "UNFULFILLED", currentTotalPriceSet: { shopMoney: { amount: "1947.00" } }, shippingAddress: null,
      lineItems: { nodes: [node("a", 2, 0, "old"), node("b", 2, 2, "new"), node("c", 3, 1, "part"), node("d", 1, undefined, "legacy")] } } }) };
    const o = await readEditableOrder(client as never, "1");
    assert.deepEqual(o.lines.map((l) => [l.id, l.variantId, l.quantity]), [["b", "new", 2], ["c", "part", 1], ["d", "legacy", 1]]);
  });
});
