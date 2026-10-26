// "Sync / Update from CRM" through the REAL OrderSyncService. ONE rolled-back transaction on the isolated test database; synthetic data; Shopify is a stateful fake that records every document it receives, so the tests
// can assert both what changed and what was NEVER called (payments, refunds, fulfilment, cancellation, order edits, WhatsApp).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import OrderSyncService from "./orders.sync.service.js";
import { validateSyncApply } from "./orders.validators.js";
import type { SyncItem } from "../shopify/shopify.order-sync.compare.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 90_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());
const uid = () => randomUUID();
const num = () => String(Math.floor(1e8 + Math.random() * 9e8));
const PHONE = "+919811900001";

interface Cust { id: string; phone: string; firstName: string | null; lastName: string | null }
interface Shop {
  updatedAt: number;
  cancelledAt: string | null;
  fin: string;
  ful: string;
  tags: string[];
  total: string;
  shipping: string;
  discounts: string;
  tax: string;
  refunded: string;
  customerId: string | null;
  customers: Cust[];
  address: Record<string, string | null>;
  lines: { variant: string; qty: number; price: string }[];
}
interface Opts { delayMs?: number; addressFails?: boolean; tagsNotKept?: boolean; createTaken?: boolean; missing?: boolean }

const OLD_ADDRESS = { firstName: "Meera", lastName: "Rao", address1: "Old line", address2: null, city: "Pune", provinceCode: "MH", zip: "411001", phone: null };

function fake(shop: Shop, opts: Opts = {}) {
  const docs: string[] = [];
  const requested: string[] = [];
  const money = (a: string) => ({ shopMoney: { amount: a } });
  const customer = () => shop.customers.find((c) => c.id === shop.customerId) ?? null;
  const bump = () => { shop.updatedAt += 1; };
  const node = (c: Cust) => ({ id: c.id, firstName: c.firstName, lastName: c.lastName, email: null, phone: c.phone, numberOfOrders: "1", amountSpent: null, defaultAddress: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  const client = {
    query: async (doc: string, vars: any) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const name = /(?:query|mutation)\s+(\w+)/.exec(doc)?.[1] ?? "";
      docs.push(name || doc.slice(0, 30));
      const c = customer();
      if (name === "crmOrderForSync") {
        requested.push(vars.id);
        if (opts.missing) return { order: null };
        return { order: { id: "gid://shopify/Order/555", name: "#AWL1", updatedAt: `2026-10-26T05:30:${String(shop.updatedAt).padStart(2, "0")}Z`, cancelledAt: shop.cancelledAt, displayFinancialStatus: shop.fin, displayFulfillmentStatus: shop.ful, currencyCode: "INR", tags: shop.tags, note: null,
          totalPriceSet: money(shop.total), currentTotalPriceSet: money(shop.total), totalShippingPriceSet: money(shop.shipping), totalDiscountsSet: money(shop.discounts), totalTaxSet: money(shop.tax), totalRefundedSet: money(shop.refunded), totalOutstandingSet: money(shop.total),
          customer: c ? { id: c.id, firstName: c.firstName, lastName: c.lastName, phone: c.phone, email: null } : null, shippingAddress: shop.address, billingAddress: shop.address,
          shippingLines: { nodes: Number(shop.shipping) > 0 ? [{ title: "Shipping" }] : [] }, lineItems: { nodes: shop.lines.map((l) => ({ quantity: l.qty, variant: { id: l.variant }, originalUnitPriceSet: money(l.price) })) } } };
      }
      if (name === "crmAudit") {
        return { nodes: vars.ids.map((id: string) => ({ id, name: "#AWL1", cancelledAt: shop.cancelledAt, displayFinancialStatus: shop.fin, displayFulfillmentStatus: shop.ful, currencyCode: "INR", totalPriceSet: money(shop.total), currentTotalPriceSet: money(shop.total), totalShippingPriceSet: money(shop.shipping), totalDiscountsSet: money(shop.discounts), totalTaxSet: money(shop.tax), totalRefundedSet: money(shop.refunded),
          customer: c ? { id: c.id, firstName: c.firstName, lastName: c.lastName, phone: c.phone } : null, shippingAddress: shop.address })) };
      }
      if (name === "crmOrderForEdit") {
        return { order: { id: "gid://shopify/Order/555", cancelledAt: shop.cancelledAt, displayFulfillmentStatus: shop.ful, currentTotalPriceSet: money(shop.total), lineItems: { nodes: [] }, shippingAddress: { ...shop.address, countryCodeV2: "IN" } } };
      }
      if (/customers\(/.test(doc)) return { customers: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: shop.customers.map(node) } };
      if (name === "crmCustomerCreate") {
        if (opts.createTaken) return { customerCreate: { customer: null, userErrors: [{ field: ["phone"], message: "Phone has already been taken" }] } };
        const created = { id: `gid://shopify/Customer/${700 + shop.customers.length}`, phone: vars.input.phone, firstName: vars.input.firstName ?? null, lastName: vars.input.lastName ?? null };
        shop.customers.push(created); bump();
        return { customerCreate: { customer: created, userErrors: [] } };
      }
      if (name === "crmCustomerUpdate") {
        const t = shop.customers.find((x) => x.id === vars.input.id)!;
        t.firstName = vars.input.firstName ?? t.firstName; t.lastName = vars.input.lastName ?? t.lastName; bump();
        return { customerUpdate: { customer: t, userErrors: [] } };
      }
      if (name === "crmOrderCustomerSet") { shop.customerId = vars.customerId; bump(); return { orderCustomerSet: { order: { id: vars.orderId, customer: { id: vars.customerId } }, userErrors: [] } }; }
      if (name === "crmOrderShippingAddressUpdate") {
        if (opts.addressFails) return { orderUpdate: { order: null, userErrors: [{ field: ["shippingAddress"], message: "Enter a last name" }] } };
        const a = vars.input.shippingAddress;
        shop.address = { firstName: a.firstName ?? null, lastName: a.lastName ?? null, address1: a.address1 ?? null, address2: a.address2 ?? null, city: a.city ?? null, provinceCode: a.provinceCode ?? null, zip: a.zip ?? null, phone: a.phone ?? null }; bump();
        return { orderUpdate: { order: { id: vars.input.id }, userErrors: [] } };
      }
      if (name === "crmTagsAdd") { if (!opts.tagsNotKept) shop.tags = [...shop.tags, ...vars.tags]; bump(); return { tagsAdd: { userErrors: [] } }; }
      throw new Error(`unexpected Shopify document: ${name || doc.slice(0, 40)}`);
    },
  };
  return { client, docs, requested };
}

const baseShop = (over: Partial<Shop> = {}): Shop => ({ updatedAt: 1, cancelledAt: null, fin: "PENDING", ful: "UNFULFILLED", tags: ["CRM"], total: "649.00", shipping: "0.00", discounts: "0.00", tax: "0.00", refunded: "0.00", customerId: null, customers: [], address: { ...OLD_ADDRESS }, lines: [], ...over });

async function world(tx: Prisma.TransactionClient, over: { source?: "SALESPERSON" | "SHOPIFY"; linked?: boolean; status?: string; shipment?: boolean; payment?: string; email?: string | null; qty?: number } = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const manager = await tx.user.create({ data: { name: "Manager", username: `m-${uid()}`, role: Role.MANAGER } });
  const asha = await tx.user.create({ data: { name: "Asha", username: `t1-${uid()}`, role: Role.SALESPERSON } });
  const bala = await tx.user.create({ data: { name: "Bala", username: `t2-${uid()}`, role: Role.SALESPERSON } });
  const hr = await tx.user.create({ data: { name: "HR", username: `h-${uid()}`, role: Role.HR } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Meera", lastName: "Rao", mobile: "9811900001", normalizedMobile: PHONE, email: over.email ?? null, ownerId: asha.id } });
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "649.00" } });
  const variant = await tx.productVariant.create({ data: { productId: product.id, name: "Gutka", price: "649.00", externalId: num(), externalSource: "SHOPIFY" } });
  const qty = over.qty ?? 1;
  const order = await tx.order.create({
    data: {
      orderNumber: `CRM-${uid().slice(0, 8)}`, leadId: lead.id, source: over.source ?? "SALESPERSON", status: (over.status ?? "CONFIRMED") as never, subtotal: String(649 * qty), discountAmount: "0.00", shippingAmount: "50.00", taxAmount: "0.00", totalAmount: String(649 * qty + 50),
      createdById: asha.id, shippingPincode: "411045", shippingAddress: { name: "Meera Rao", line1: "Flat 9, New Heights", line2: "Baner Road", city: "Pune", state: "Maharashtra", pincode: "411045", landmark: "Near park" } as Prisma.InputJsonValue,
      metadata: { paymentMode: "COD", createdBy: { id: asha.id, name: "Aayush Tiwari", role: "SALESPERSON" } } as Prisma.InputJsonValue,
      ...(over.linked === false ? {} : { externalSource: "SHOPIFY" as const, externalId: "555", externalNumber: "#AWL1" }),
      items: { create: [{ productId: product.id, variantId: variant.id, productNameSnapshot: "Herbal Masala", variantNameSnapshot: "Gutka", quantity: qty, unitPrice: "649.00", totalPrice: String(649 * qty) }] },
      payments: { create: { amount: String(649 * qty + 50), method: "COD", status: (over.payment ?? "PENDING") as never } },
      ...(over.shipment ? { shipments: { create: { status: "SHIPPED" } } } : {}),
    },
    select: { id: true },
  });
  const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });
  return { admin, manager, asha, bala, hr, order, lead, variantGid: `gid://shopify/ProductVariant/${variant.externalId}`, as };
}
const svc = (tx: Prisma.TransactionClient, f: ReturnType<typeof fake>) => new OrderSyncService(tx as never, () => f.client as never, () => new Date("2026-10-26T10:00:00Z"), 0);
const FORBIDDEN = /payment|refund|fulfil|cancel|orderEdit|markAsPaid|whatsapp|capture|transaction/i;
const byKey = (p: { items: SyncItem[] }, key: string) => p.items.find((i) => i.key === key)!;

describe("Sync from CRM - preview (read-only)", () => {
  it("#AWL105195: CRM 649 + 50 shipping = 699 vs Shopify 649 with no shipping line - the shipping line and total are DIFFERENT, explained, and NOT syncable; customer, address and tags are", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const f = fake(baseShop({ lines: [{ variant: w.variantGid, qty: 1, price: "649.00" }] }));
      const p = await svc(tx, f).preview(w.as(w.asha, Role.SALESPERSON), w.order.id);
      assert.equal(p.comparable, true);
      assert.equal(byKey(p, "total").status, "DIFFERENT");
      assert.equal(byKey(p, "total").crm, "699.00");
      assert.equal(byKey(p, "total").shopify, "649.00");
      assert.match(byKey(p, "total").blocked!, /shipping 50\.00 that the Shopify order has no shipping line for/);
      assert.match(byKey(p, "total").blocked!, /never forced to match/);
      assert.equal(byKey(p, "shipping.line").action, null);
      assert.match(byKey(p, "shipping.line").blocked!, /approve an explicit Shopify order edit/);
      assert.equal(byKey(p, "discount").status, "SYNCED");
      assert.equal(byKey(p, "items").status, "SYNCED", "quantity and variant agree");
      assert.deepEqual(["customer.link", "shipping.address", "tags"].map((k) => byKey(p, k).action), ["customer.link", "shipping.address", "tags.add"]);
      assert.deepEqual(f.docs.filter((d) => /^crm(Customer|Order(Customer|Shipping))|Tags/.test(d)), [], "preview mutates nothing");
      assert.ok(p.stateToken);
      assert.equal(p.summary.manualReview > 0, true);
    });
  });

  it("line items / variants / quantity, tax, discount, rounding and payment differences are reported and never selectable (quantity 2 case)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { qty: 2 });
      const f = fake(baseShop({ total: "1348.00", shipping: "50.00", tax: "10.00", discounts: "20.00", fin: "PAID", lines: [{ variant: w.variantGid, qty: 1, price: "649.00" }] }));
      const p = await svc(tx, f).preview(w.as(w.asha, Role.SALESPERSON), w.order.id);
      for (const k of ["items", "tax", "discount", "payment"]) {
        assert.equal(byKey(p, k).status, "DIFFERENT", k);
        assert.equal(byKey(p, k).action, null, k);
        assert.ok(byKey(p, k).blocked, k);
      }
      assert.match(byKey(p, "items").blocked!, /order edit/);
      assert.equal(byKey(p, "shipping.line").status, "SYNCED");
    });
  });

  it("states: fulfilled, cancelled, shipment, refund - the address (and for cancelled / refund the customer) is blocked with the reason; payments / fulfilment are only reported", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const u = w.as(w.asha, Role.SALESPERSON);
      const lines = [{ variant: w.variantGid, qty: 1, price: "649.00" }];
      const ful = await svc(tx, fake(baseShop({ ful: "FULFILLED", lines }))).preview(u, w.order.id);
      assert.equal(byKey(ful, "shipping.address").action, null);
      assert.match(byKey(ful, "shipping.address").blocked!, /fulfilled/);
      assert.equal(byKey(ful, "customer.link").action, "customer.link", "linking a customer changes no amount, so a fulfilled order is allowed");
      const can = await svc(tx, fake(baseShop({ cancelledAt: "2026-10-20T00:00:00Z", lines }))).preview(u, w.order.id);
      assert.equal(byKey(can, "customer.link").action, null);
      assert.match(byKey(can, "customer.link").blocked!, /cancelled/);
      assert.equal(byKey(can, "tags").action, null);
      const ref = await svc(tx, fake(baseShop({ refunded: "100.00", lines }))).preview(u, w.order.id);
      assert.match(byKey(ref, "shipping.address").blocked!, /refund/);
      assert.equal(byKey(ref, "customer.link").action, null);
      assert.equal(ref.orderState?.refunds, true);
    });
    await inRollback(async (tx) => {
      const w = await world(tx, { shipment: true });
      const p = await svc(tx, fake(baseShop())).preview(w.as(w.asha, Role.SALESPERSON), w.order.id);
      assert.match(byKey(p, "shipping.address").blocked!, /shipment exists/);
    });
  });

  it("customer rules: an existing Shopify name is never overwritten (different name = report only), a blank name is syncable, phone / e-mail belong to the Shopify customer", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { email: "meera@example.invalid" });
      const u = w.as(w.asha, Role.SALESPERSON);
      const other = baseShop({ customers: [{ id: "gid://shopify/Customer/1", phone: "+919000000000", firstName: "Suresh", lastName: "Kumar" }], customerId: "gid://shopify/Customer/1", address: { ...OLD_ADDRESS } });
      const p = await svc(tx, fake(other)).preview(u, w.order.id);
      assert.equal(byKey(p, "customer.name").action, null);
      assert.match(byKey(p, "customer.name").blocked!, /never overwritten/);
      assert.equal(byKey(p, "customer.phone").action, null);
      assert.equal(byKey(p, "customer.email").status, "DIFFERENT");
      const blank = baseShop({ customers: [{ id: "gid://shopify/Customer/2", phone: PHONE, firstName: null, lastName: null }], customerId: "gid://shopify/Customer/2" });
      assert.equal(byKey(await svc(tx, fake(blank)).preview(u, w.order.id), "customer.name").action, "customer.name");
    });
  });

  it("not comparable: an order not linked to Shopify, and a store (Shopify-origin) order", async () => {
    await inRollback(async (tx) => {
      const unlinked = await world(tx, { linked: false });
      const a = await svc(tx, fake(baseShop())).preview(unlinked.as(unlinked.asha, Role.SALESPERSON), unlinked.order.id);
      assert.equal(a.comparable, false);
      assert.match(a.note!, /not linked to a Shopify order/);
      const site = await world(tx, { source: "SHOPIFY" });
      const b = await svc(tx, fake(baseShop())).preview(site.as(site.admin, Role.ADMIN), site.order.id);
      assert.equal(b.comparable, false);
      assert.match(b.note!, /source of truth/);
    });
  });

  it("permissions: anyone who can open the order page can review it (owner, admin, another telecaller, a manager outside the team); HR is refused; a missing order is 'Order not found'", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const s = svc(tx, fake(baseShop()));
      for (const [u, role] of [[w.asha, Role.SALESPERSON], [w.admin, Role.ADMIN], [w.bala, Role.SALESPERSON], [w.manager, Role.MANAGER]] as const) {
        assert.equal((await s.preview(w.as(u, role), w.order.id)).comparable, true, `${role} ${u.username}`);
      }
      await assert.rejects(s.preview(w.as(w.hr, Role.HR), w.order.id), (e: any) => e.statusCode === 403);
      await assert.rejects(s.preview(w.as(w.admin, Role.ADMIN), "00000000-0000-4000-8000-000000000000"), (e: any) => e.statusCode === 404 && /Order not found/.test(e.message));
    });
  });
});

describe("Sync from CRM - apply", () => {
  const confirm = (p: { stateToken: string | null }, actions: any[]) => ({ stateToken: p.stateToken!, actions, confirm: true });

  it("applies customer + address + tags, re-reads Shopify, verifies, records who did it - and leaves total, shipping line, payment and fulfilment untouched with NO payment / refund / fulfilment / cancel / order-edit / WhatsApp call", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const shop = baseShop({ lines: [{ variant: w.variantGid, qty: 1, price: "649.00" }] });
      const f = fake(shop);
      const s = svc(tx, f);
      const u = w.as(w.asha, Role.SALESPERSON);
      const p = await s.preview(u, w.order.id);
      const r = await s.apply(u, w.order.id, confirm(p, ["customer.link", "shipping.address", "tags.add"]));
      assert.equal(r.outcome, "synced");
      assert.deepEqual(r.results.map((x) => x.status), ["applied", "applied", "applied"]);
      assert.equal(shop.customers.length, 1);
      assert.equal(shop.customers[0]!.firstName, "Meera");
      assert.equal(shop.customerId, shop.customers[0]!.id);
      assert.equal(shop.address.address1, "Flat 9, New Heights");
      assert.equal(shop.address.zip, "411045");
      assert.ok(shop.tags.includes("Order Created by Aayush Tiwari"));
      // verified by the re-read: those items are now in sync, the financial ones are still (honestly) listed as differences
      for (const k of ["customer.link", "shipping.address", "tags"]) assert.equal(byKey(r.preview, k).status, "SYNCED", k);
      assert.equal(byKey(r.preview, "total").status, "DIFFERENT");
      assert.deepEqual([shop.total, shop.shipping, shop.fin, shop.ful], ["649.00", "0.00", "PENDING", "UNFULFILLED"], "no money, payment or fulfilment change");
      assert.ok(f.docs.every((d) => !FORBIDDEN.test(d)), `unexpected documents: ${f.docs.filter((d) => FORBIDDEN.test(d))}`);
      assert.equal(r.preview.lastSyncedAt, "2026-10-26T10:00:00.000Z");
      const audit = await tx.activity.findMany({ where: { orderId: w.order.id } });
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.actorId, w.asha.id);
      assert.match(audit[0]!.title ?? "", /Sync from CRM to Shopify \(synced\)/);
      const stored = await tx.order.findUniqueOrThrow({ where: { id: w.order.id }, select: { totalAmount: true, shippingAddress: true, metadata: true } });
      assert.equal(stored.totalAmount.toString(), "699", "the CRM order itself is not changed");
      assert.equal((stored.metadata as any).orderEditClaimedAt, undefined, "claim released");
    });
  });

  it("explicit confirmation is required, at least one change must be chosen, and an unknown action is refused", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const s = svc(tx, fake(baseShop()));
      const u = w.as(w.asha, Role.SALESPERSON);
      const p = await s.preview(u, w.order.id);
      await assert.rejects(s.apply(u, w.order.id, { stateToken: p.stateToken!, actions: ["tags.add"], confirm: false }), (e: any) => e.statusCode === 400 && /Confirm/.test(e.message));
      await assert.rejects(s.apply(u, w.order.id, { stateToken: p.stateToken!, actions: [], confirm: true }), (e: any) => e.statusCode === 400);
      assert.ok(validateSyncApply({ stateToken: p.stateToken, actions: ["shipping.line"], confirm: true }).error, "financial edits are not even a valid action");
      assert.ok(validateSyncApply({ stateToken: p.stateToken, actions: ["tags.add"] }).error, "missing confirm");
      assert.ifError(validateSyncApply({ stateToken: "abcdefgh12345678", actions: ["tags.add"], confirm: true }).error);
    });
  });

  it("a STALE comparison is refused: Shopify changed, or the CRM customer changed, after the preview - nothing is written", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const shop = baseShop();
      const f = fake(shop);
      const s = svc(tx, f);
      const u = w.as(w.asha, Role.SALESPERSON);
      const p = await s.preview(u, w.order.id);
      shop.updatedAt += 1; // someone edited the order in Shopify
      shop.tags = ["CRM", "Hold"];
      await assert.rejects(s.apply(u, w.order.id, confirm(p, ["tags.add"])), (e: any) => e.statusCode === 409 && e.data?.code === "STALE_PREVIEW");
      assert.equal(shop.tags.length, 2);
      const p2 = await s.preview(u, w.order.id);
      await tx.lead.update({ where: { id: w.lead.id }, data: { lastName: "Sharma" } }); // the CRM changed
      await assert.rejects(s.apply(u, w.order.id, confirm(p2, ["tags.add"])), (e: any) => e.statusCode === 409);
      assert.ok(f.docs.every((d) => !/^crmTagsAdd|crmCustomer|crmOrderShipping|crmOrderCustomerSet/.test(d)));
    });
  });

  it("two syncs at once: one runs, the other is refused (409) - Shopify is written once - and a failed run releases the claim", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const shop = baseShop();
      const f = fake(shop, { delayMs: 12 });
      const s = svc(tx, f);
      const u = w.as(w.asha, Role.SALESPERSON);
      const p = await s.preview(u, w.order.id);
      const results = await Promise.allSettled([s.apply(u, w.order.id, confirm(p, ["tags.add"])), s.apply(u, w.order.id, confirm(p, ["tags.add"]))]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as any).statusCode, 409);
      assert.equal(f.docs.filter((d) => d === "crmTagsAdd").length, 1);
      assert.equal(shop.tags.filter((t) => t.startsWith("Order Created by")).length, 1);
    });
  });

  it("partial failure: the address is refused by Shopify but customer and tags are synced - outcome 'partial', the failure is reported and recorded, nothing is half-written in the CRM", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const shop = baseShop();
      const s = svc(tx, fake(shop, { addressFails: true }));
      const u = w.as(w.asha, Role.SALESPERSON);
      const p = await s.preview(u, w.order.id);
      const r = await s.apply(u, w.order.id, confirm(p, ["customer.link", "shipping.address", "tags.add"]));
      assert.equal(r.outcome, "partial");
      assert.deepEqual(Object.fromEntries(r.results.map((x) => [x.action, x.status])), { "customer.link": "applied", "shipping.address": "failed", "tags.add": "applied" });
      assert.match(r.results.find((x) => x.action === "shipping.address")!.message, /Enter a last name/);
      assert.equal(byKey(r.preview, "shipping.address").status, "DIFFERENT", "still listed as a remaining mismatch");
      assert.equal(shop.address.address1, "Old line");
      const retry = await s.apply(u, w.order.id, confirm(r.preview, ["shipping.address"]));
      assert.equal(retry.outcome, "failed", "a retry hits the same refusal, reported again, nothing duplicated");
      assert.equal(shop.customers.length, 1, "the customer is not created twice");
    });
  });

  it("verification: a change Shopify accepted but does not show on re-read is reported as FAILED, never as success", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const s = svc(tx, fake(baseShop(), { tagsNotKept: true }));
      const u = w.as(w.asha, Role.SALESPERSON);
      const p = await s.preview(u, w.order.id);
      const r = await s.apply(u, w.order.id, confirm(p, ["tags.add"]));
      assert.equal(r.outcome, "failed");
      assert.match(r.results[0]!.message, /re-read does not show it/);
      assert.equal(r.preview.lastSyncedAt, null, "no successful sync is recorded");
    });
  });

  it("customer cases: ambiguous phone -> nothing created or linked ('blocked'); a duplicate-phone refusal is resolved to the existing customer; reuse of a unique match fills only a blank name", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const two = baseShop({ customers: [{ id: "gid://shopify/Customer/1", phone: PHONE, firstName: "Meera", lastName: null }, { id: "gid://shopify/Customer/2", phone: PHONE, firstName: "Meera", lastName: null }] });
      const f = fake(two);
      const s = svc(tx, f);
      const u = w.as(w.asha, Role.SALESPERSON);
      const p = await s.preview(u, w.order.id);
      const r = await s.apply(u, w.order.id, confirm(p, ["customer.link"]));
      assert.equal(r.outcome, "blocked");
      assert.match(r.results[0]!.message, /2 different Shopify customers/);
      assert.equal(two.customerId, null);
      assert.ok(!f.docs.includes("crmCustomerCreate") && !f.docs.includes("crmOrderCustomerSet"));
    });
    await inRollback(async (tx) => {
      const w = await world(tx);
      const one = baseShop({ customers: [{ id: "gid://shopify/Customer/9", phone: PHONE, firstName: "Meera", lastName: "Rao" }] });
      const f = fake(one);
      const u = w.as(w.asha, Role.SALESPERSON);
      const p = await svc(tx, f).preview(u, w.order.id);
      const r = await svc(tx, f).apply(u, w.order.id, confirm(p, ["customer.link"]));
      assert.equal(r.outcome, "synced");
      assert.equal(one.customerId, "gid://shopify/Customer/9");
      assert.ok(!f.docs.includes("crmCustomerCreate") && !f.docs.includes("crmCustomerUpdate"), "reused as is: no create, no name overwrite");
    });
  });

  it("permissions on apply: another telecaller and HR are refused; the owner, a manager of the team's order scope and an admin can sync", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const s = svc(tx, fake(baseShop()));
      const p = await s.preview(w.as(w.admin, Role.ADMIN), w.order.id);
      await assert.rejects(s.apply(w.as(w.bala, Role.SALESPERSON), w.order.id, confirm(p, ["tags.add"])), (e: any) => e.statusCode === 403 && /you can only change orders you created/.test(e.message));
      await assert.rejects(s.apply(w.as(w.hr, Role.HR), w.order.id, confirm(p, ["tags.add"])), (e: any) => e.statusCode === 403);
      const r = await s.apply(w.as(w.admin, Role.ADMIN), w.order.id, confirm(p, ["tags.add"]));
      assert.equal(r.outcome, "synced");
    });
  });

  it("an action the order state does not allow is 'blocked' and nothing is sent: shipping address on a fulfilled order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const shop = baseShop({ ful: "FULFILLED" });
      const f = fake(shop);
      const u = w.as(w.asha, Role.SALESPERSON);
      const p = await svc(tx, f).preview(u, w.order.id);
      const r = await svc(tx, f).apply(u, w.order.id, confirm(p, ["shipping.address"]));
      assert.equal(r.outcome, "blocked");
      assert.match(r.results[0]!.message, /fulfilled/);
      assert.equal(shop.address.address1, "Old line");
    });
  });
});

describe("out-of-sync report (read-only, Admin / Manager)", () => {
  it("buckets every CRM order pushed to Shopify, includes the #AWL105195-shaped order as a FINANCIAL mismatch with the cause, and is refused to telecallers", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const shop = baseShop({ lines: [{ variant: w.variantGid, qty: 1, price: "649.00" }] });
      const f = fake(shop);
      const s = svc(tx, f);
      await assert.rejects(s.report(w.as(w.asha, Role.SALESPERSON)), (e: any) => e.statusCode === 403);
      const r = await s.report(w.as(w.admin, Role.ADMIN), { fresh: true });
      const mine = r.items.find((i) => i.crmOrderId === w.order.id)!;
      assert.equal(mine.category, "FINANCIAL");
      assert.equal(mine.crmTotal, "699.00");
      assert.equal(mine.shopifyTotal, "649.00");
      assert.equal(mine.difference, "50.00");
      assert.equal(mine.customerAssociation, "NOT LINKED");
      assert.match(mine.proposedRepair, /shipping 50\.00/);
      assert.ok(r.counts.FINANCIAL >= 1);
      assert.ok(f.docs.every((d) => d === "crmAudit"), "the report only reads");
    });
    await inRollback(async (tx) => {
      const w = await world(tx);
      const shop = baseShop({ total: "699.00", shipping: "50.00", address: { ...OLD_ADDRESS } });
      const r = await svc(tx, fake(shop)).report(w.as(w.manager, Role.MANAGER), { fresh: true });
      assert.equal(r.items.find((i) => i.crmOrderId === w.order.id)!.category, "SAFE_CUSTOMER", "totals agree; the customer is missing");
    });
  });
});

describe("Sync from CRM - 'Order not found' regression (CRM-MVP7FFBC-UN0A shape)", () => {
  it("a linked order whose lead is assigned to a manager who does NOT manage the creator's group (and the lead has no group): that manager can open the comparison - no 'Order not found' - but applying is a clear 403, and nothing is written", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await tx.lead.update({ where: { id: w.lead.id }, data: { assignedManagerId: w.manager.id } });
      const shop = baseShop();
      const f = fake(shop);
      const s = svc(tx, f);
      const mgr = w.as(w.manager, Role.MANAGER);
      const p = await s.preview(mgr, w.order.id);
      assert.equal(p.comparable, true);
      assert.notEqual(p.note, "Order not found");
      assert.ok(p.stateToken);
      await assert.rejects(s.apply(mgr, w.order.id, { stateToken: p.stateToken!, actions: ["tags.add"], confirm: true }), (e: any) => e.statusCode === 403 && !/Order not found/.test(e.message) && /you can only change orders/.test(e.message));
      assert.ok(f.docs.every((d) => !/crmTagsAdd|crmCustomer|crmOrderShipping|crmOrderCustomerSet/.test(d)), "nothing was written");
      assert.equal(shop.tags.length, 1);
    });
  });

  it("only an order that really does not exist is 'Order not found' (404); an unlinked order says so in plain words", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { linked: false });
      const s = svc(tx, fake(baseShop()));
      const p = await s.preview(w.as(w.asha, Role.SALESPERSON), w.order.id);
      assert.equal(p.comparable, false);
      assert.equal(p.note, "This CRM order is not linked to a Shopify order, so there is nothing to compare. Push it to Shopify first.");
      await assert.rejects(s.preview(w.as(w.admin, Role.ADMIN), "11111111-1111-4111-8111-111111111111"), (e: any) => e.statusCode === 404);
    });
  });

  it("the linked Shopify order is looked up by its canonical GID whatever form the CRM stored (numeric id or full GID); an id Shopify no longer has is a clear 409, not 'Order not found'", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const numeric = fake(baseShop());
      await svc(tx, numeric).preview(w.as(w.admin, Role.ADMIN), w.order.id);
      await tx.order.update({ where: { id: w.order.id }, data: { externalId: "gid://shopify/Order/555" } }); // the legacy GID form the CRM pushed before ids were canonicalised
      const gid = fake(baseShop());
      await svc(tx, gid).preview(w.as(w.admin, Role.ADMIN), w.order.id);
      assert.deepEqual([numeric.requested[0], gid.requested[0]], ["gid://shopify/Order/555", "gid://shopify/Order/555"]);
      const gone = fake(baseShop(), { missing: true });
      await assert.rejects(svc(tx, gone).preview(w.as(w.admin, Role.ADMIN), w.order.id), (e: any) => e.statusCode === 409 && e.data?.code === "SHOPIFY_ORDER_MISSING" && /no longer exists in Shopify/.test(e.message) && !/Order not found/.test(e.message));
    });
  });

  it("an invalid identifier is refused by the route validator before any lookup", async () => {
    const { validateOrderIdParams } = await import("./orders.validators.js");
    assert.ok(validateOrderIdParams({ id: "CRM-MVP7FFBC-UN0A" }).error, "the CRM order NUMBER is not the order id");
    assert.ok(validateOrderIdParams({ id: "18963313066173" }).error, "a Shopify numeric id is not a CRM id");
    assert.ok(validateOrderIdParams({ id: "gid://shopify/Order/18963313066173" }).error, "a Shopify GID is not a CRM id");
    assert.ifError(validateOrderIdParams({ id: "1f1a842b-0000-4000-8000-000000000000" }).error);
  });
});
