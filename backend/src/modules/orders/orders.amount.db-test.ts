// "Review & Correct Amount" through the REAL OrderAmountService. ONE rolled-back transaction on the isolated test database; synthetic data; Shopify is a stateful fake that follows the order-edit call sequence and
// records every document, and the courier (Shiprocket) lookup is injected. Nothing leaves the process.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShiprocketOrderLookup } from "../shiprocket/shiprocket.client.js";
import { parseOrderLookups } from "../shiprocket/shiprocket.client.js";
import OrderAmountService from "./orders.amount.service.js";
import { validateAmountCorrection } from "./orders.validators.js";

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

interface Shop {
  updatedAt: number;
  cancelledAt: string | null;
  fin: string;
  ful: string;
  total: number; // cents
  outstanding: number;
  shipping: number;
  shippingLines: number;
  discounts: number;
  tax: number;
  refunded: number;
  transactions: number;
  lines: { variant: string; qty: number; price: number }[];
}
interface Opts { delayMs?: number; commitFails?: boolean; commitNoop?: boolean; stagedExtra?: number }

function fake(shop: Shop, opts: Opts = {}) {
  const docs: string[] = [];
  let staged: { shipping: number } | null = null;
  const money = (c: number) => ({ shopMoney: { amount: (c / 100).toFixed(2) } });
  const client = {
    query: async (doc: string, vars: any) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const name = /(?:query|mutation)\s+(\w+)/.exec(doc)?.[1] ?? "";
      docs.push(name);
      if (name === "crmOrderForSync") {
        return { order: { id: "gid://shopify/Order/555", name: "#AWL1", updatedAt: `2026-10-26T05:30:${String(shop.updatedAt).padStart(2, "0")}Z`, cancelledAt: shop.cancelledAt, displayFinancialStatus: shop.fin, displayFulfillmentStatus: shop.ful, currencyCode: "INR", tags: [], note: null,
          totalPriceSet: money(shop.total), currentTotalPriceSet: money(shop.total), totalShippingPriceSet: money(shop.shipping), totalDiscountsSet: money(shop.discounts), totalTaxSet: money(shop.tax), totalRefundedSet: money(shop.refunded), totalOutstandingSet: money(shop.outstanding),
          customer: null, shippingAddress: null, billingAddress: null, shippingLines: { nodes: Array.from({ length: shop.shippingLines }, () => ({ title: "Shipping" })) }, transactions: Array.from({ length: shop.transactions }, () => ({ kind: "SALE" })),
          lineItems: { nodes: shop.lines.map((l) => ({ quantity: l.qty, variant: { id: l.variant }, originalUnitPriceSet: money(l.price) })) } } };
      }
      if (name === "crmFlavourEditBegin") { staged = { shipping: 0 }; return { orderEditBegin: { calculatedOrder: { id: "gid://shopify/CalculatedOrder/9" }, userErrors: [] } }; }
      if (name === "crmAmountEditAddShipping") {
        staged!.shipping = Math.round(Number(vars.shippingLine.price.amount) * 100);
        return { orderEditAddShippingLine: { calculatedOrder: { totalPriceSet: money(shop.total + staged!.shipping + (opts.stagedExtra ?? 0)) }, userErrors: [] } };
      }
      if (name === "crmFlavourEditCommit") {
        if (opts.commitFails) return { orderEditCommit: { order: null, userErrors: [{ field: null, message: "Access denied for orderEditCommit field" }] } };
        if (!opts.commitNoop) { shop.total += staged!.shipping; shop.outstanding += staged!.shipping; shop.shipping += staged!.shipping; shop.shippingLines += 1; shop.updatedAt += 1; }
        return { orderEditCommit: { order: { id: "gid://shopify/Order/555" }, userErrors: [] } };
      }
      throw new Error(`unexpected Shopify document: ${name}`);
    },
  };
  return { client, docs };
}

const baseShop = (over: Partial<Shop> = {}): Shop => ({ updatedAt: 1, cancelledAt: null, fin: "PENDING", ful: "UNFULFILLED", total: 64900, outstanding: 64900, shipping: 0, shippingLines: 0, discounts: 0, tax: 0, refunded: 0, transactions: 0, lines: [], ...over });
const sr = (over: Partial<ShiprocketOrderLookup> = {}): ShiprocketOrderLookup => ({ shiprocketOrderId: "1674155947", channelOrderId: "AWL1", status: "NEW", paymentMethod: "cod", totalCents: 64900, awb: null, courier: null, ...over });

async function world(tx: Prisma.TransactionClient, over: { qty?: number; mode?: "COD" | "PREPAID"; status?: string; shipment?: boolean; payment?: string; shipping?: string } = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const manager = await tx.user.create({ data: { name: "Manager", username: `m-${uid()}`, role: Role.MANAGER } });
  const asha = await tx.user.create({ data: { name: "Asha", username: `t1-${uid()}`, role: Role.SALESPERSON } });
  const bala = await tx.user.create({ data: { name: "Bala", username: `t2-${uid()}`, role: Role.SALESPERSON } });
  const hr = await tx.user.create({ data: { name: "HR", username: `h-${uid()}`, role: Role.HR } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Meera", lastName: "Rao", mobile: "9811900001", normalizedMobile: "+919811900001", ownerId: asha.id } });
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "649.00" } });
  const variant = await tx.productVariant.create({ data: { productId: product.id, name: "Gutka", price: "649.00", externalId: num(), externalSource: "SHOPIFY" } });
  const qty = over.qty ?? 1;
  const ship = over.shipping ?? "50.00";
  const order = await tx.order.create({
    data: {
      orderNumber: `CRM-${uid().slice(0, 8)}`, leadId: lead.id, source: "SALESPERSON", status: (over.status ?? "CONFIRMED") as never, subtotal: String(649 * qty), discountAmount: "0.00", shippingAmount: ship, taxAmount: "0.00", totalAmount: String(649 * qty + Number(ship)),
      createdById: asha.id, externalSource: "SHOPIFY", externalId: num(), externalNumber: "#AWL1",
      metadata: { paymentMode: over.mode ?? "COD" } as Prisma.InputJsonValue,
      items: { create: [{ productId: product.id, variantId: variant.id, productNameSnapshot: "Herbal Masala", variantNameSnapshot: "Gutka", quantity: qty, unitPrice: "649.00", totalPrice: String(649 * qty) }] },
      payments: { create: { amount: String(649 * qty + Number(ship)), method: over.mode === "PREPAID" ? "UPI" : "COD", status: (over.payment ?? "PENDING") as never } },
      ...(over.shipment ? { shipments: { create: { status: "SHIPPED" } } } : {}),
    },
    select: { id: true },
  });
  const variantGid = `gid://shopify/ProductVariant/${variant.externalId}`;
  const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });
  return { admin, manager, asha, bala, hr, order, variantGid, as, qty };
}
const svc = (tx: Prisma.TransactionClient, f: ReturnType<typeof fake>, courier: ShiprocketOrderLookup[] | Error = []) =>
  new OrderAmountService(tx as never, () => f.client as never, async () => { if (courier instanceof Error) throw courier; return courier; }, () => new Date("2026-10-26T10:00:00Z"));
const MUTATIONS = /^(crmFlavourEdit|crmAmountEdit)/;
const apply = (p: { stateToken: string | null }, total = "699.00") => ({ stateToken: p.stateToken!, confirmTotal: total, confirm: true });

describe("Review & Correct Amount - #AWL105195 (CRM 649 + 50 = 699, Shopify 649)", () => {
  it("compares the money, proposes the missing 50.00 shipping line with its before / after, and BLOCKS it while Shiprocket holds a COD amount of 649.00 - no Shopify edit is made", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const shop = baseShop({ lines: [{ variant: w.variantGid, qty: 1, price: 64900 }] });
      const f = fake(shop);
      const s = svc(tx, f, [sr({ totalCents: 64900 })]);
      const p = await s.preview(w.as(w.admin, Role.ADMIN), w.order.id);
      assert.deepEqual(p.rows.map((r) => [r.key, r.status]), [["items", "SAME"], ["discount", "SAME"], ["shipping", "DIFFERENT"], ["tax", "SAME"], ["refunds", "SAME"], ["total", "DIFFERENT"], ["outstanding", "DIFFERENT"]]);
      assert.equal(p.proposal?.kind, "ADD_SHIPPING_LINE");
      assert.equal(p.proposal?.amount, "50.00");
      assert.deepEqual(p.proposal?.before, { total: "649.00", outstanding: "649.00", shippingLines: 0 });
      assert.deepEqual(p.proposal?.after, { total: "699.00", outstanding: "699.00", shippingLines: 1 });
      assert.match(p.proposal!.risk, /RAISES what the customer owes/);
      const courier = p.gates.find((g) => g.key === "courier")!;
      assert.equal(courier.ok, false);
      assert.match(courier.detail, /Shiprocket's COD amount is 649\.00, not 699\.00/);
      assert.equal(p.canApply, false);
      assert.match(p.blockedReason!, /Courier amount agrees/);
      assert.equal(p.courier?.total, "649.00");
      // an apply attempt is refused and nothing is edited
      await assert.rejects(s.apply(w.as(w.admin, Role.ADMIN), w.order.id, apply(p)), (e: any) => e.statusCode === 409 && e.data?.code === "BLOCKED" && /Courier amount agrees/.test(e.message));
      assert.ok(f.docs.every((d) => !MUTATIONS.test(d)));
      assert.deepEqual([shop.total, shop.outstanding, shop.shippingLines], [64900, 64900, 0]);
    });
  });

  it("once the courier amount is 699.00 the correction is allowed: the shipping line is added through the order edit, Shopify is re-read (total 699.00, outstanding 699.00), nothing is paid, and it is audited", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const shop = baseShop({ lines: [{ variant: w.variantGid, qty: 1, price: 64900 }] });
      const f = fake(shop);
      const s = svc(tx, f, [sr({ totalCents: 69900 })]);
      const admin = w.as(w.admin, Role.ADMIN);
      const p = await s.preview(admin, w.order.id);
      assert.equal(p.canApply, true);
      const r = await s.apply(admin, w.order.id, apply(p));
      assert.equal(r.outcome, "corrected");
      assert.deepEqual(r.before, { total: "649.00", outstanding: "649.00", shippingLines: 0 });
      assert.deepEqual(r.after, { total: "699.00", outstanding: "699.00", shippingLines: 1 });
      assert.deepEqual([shop.total, shop.outstanding, shop.shipping, shop.shippingLines], [69900, 69900, 5000, 1]);
      assert.deepEqual([shop.fin, shop.ful, shop.transactions, shop.refunded], ["PENDING", "UNFULFILLED", 0, 0], "no payment, fulfilment or refund change");
      assert.deepEqual(f.docs.filter((d) => MUTATIONS.test(d)), ["crmFlavourEditBegin", "crmAmountEditAddShipping", "crmFlavourEditCommit"]);
      assert.ok(f.docs.every((d) => !/payment|refund|fulfil|cancel|markAsPaid|transaction|whatsapp/i.test(d)));
      assert.equal(r.preview.proposal, null, "nothing left to correct");
      const audit = await tx.activity.findMany({ where: { orderId: w.order.id } });
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.actorId, w.admin.id);
      assert.match(audit[0]!.title ?? "", /Amount corrected/);
      assert.deepEqual(audit[0]!.oldValue, { total: "649.00", outstanding: "649.00", shippingLines: 0 });
      const stored = await tx.order.findUniqueOrThrow({ where: { id: w.order.id }, select: { totalAmount: true, metadata: true } });
      assert.equal(stored.totalAmount.toString(), "699", "the CRM order is untouched");
      assert.equal((stored.metadata as any).amountReview.amount, "50.00");
      assert.equal((stored.metadata as any).orderEditClaimedAt, undefined, "claim released");
    });
  });

  it("retry is idempotent: after success the old token is stale, a fresh review offers nothing, and a second apply adds no second shipping line", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const shop = baseShop({ lines: [{ variant: w.variantGid, qty: 1, price: 64900 }] });
      const f = fake(shop);
      const s = svc(tx, f, [sr({ totalCents: 69900 })]);
      const admin = w.as(w.admin, Role.ADMIN);
      const p = await s.preview(admin, w.order.id);
      await s.apply(admin, w.order.id, apply(p));
      await assert.rejects(s.apply(admin, w.order.id, apply(p)), (e: any) => e.statusCode === 409 && e.data?.code === "STALE_PREVIEW");
      const fresh = await s.preview(admin, w.order.id);
      assert.equal(fresh.proposal, null);
      await assert.rejects(s.apply(admin, w.order.id, apply(fresh)), (e: any) => e.statusCode === 409 && /nothing this action may correct/.test(e.message));
      assert.equal(shop.shippingLines, 1);
      assert.equal(f.docs.filter((d) => d === "crmFlavourEditCommit").length, 1);
    });
  });
});

describe("Review & Correct Amount - gates", () => {
  const ready = async (tx: Prisma.TransactionClient, over: Parameters<typeof world>[1] = {}, shopOver: Partial<Shop> = {}, courier: ShiprocketOrderLookup[] | Error = [sr({ totalCents: 69900 })]) => {
    const w = await world(tx, over);
    const shop = baseShop({ lines: [{ variant: w.variantGid, qty: w.qty, price: 64900 }], total: 64900 * w.qty, outstanding: 64900 * w.qty, ...shopOver });
    const f = fake(shop);
    return { w, shop, f, s: svc(tx, f, courier) };
  };
  const blocked = async (label: string, r: Awaited<ReturnType<typeof ready>>, gate: string, match: RegExp) => {
    const p = await r.s.preview(r.w.as(r.w.admin, Role.ADMIN), r.w.order.id);
    assert.equal(p.canApply, false, label);
    const g = p.gates.find((x) => x.key === gate)!;
    assert.equal(g.ok, false, label);
    assert.match(g.detail, match, label);
    await assert.rejects(r.s.apply(r.w.as(r.w.admin, Role.ADMIN), r.w.order.id, apply(p, p.proposal?.after.total ?? "699.00")), (e: any) => e.statusCode === 409, label);
    assert.ok(r.f.docs.every((d) => !MUTATIONS.test(d)), `${label}: no edit`);
  };

  it("cancelled, fulfilled, partly fulfilled, CRM shipment, paid, prepaid, refunded: each BLOCKS the edit with its reason and nothing is sent", async () => {
    await inRollback(async (tx) => {
      await blocked("cancelled", await ready(tx, {}, { cancelledAt: "2026-10-20T00:00:00Z" }), "not_cancelled", /cancelled/);
      await blocked("fulfilled", await ready(tx, {}, { ful: "FULFILLED" }), "unfulfilled", /fulfilled/);
      await blocked("partly fulfilled", await ready(tx, {}, { ful: "PARTIALLY_FULFILLED" }), "unfulfilled", /partially fulfilled/);
      await blocked("shipment", await ready(tx, { shipment: true }), "no_shipment", /shipment exists/);
      await blocked("paid in Shopify", await ready(tx, {}, { fin: "PAID", outstanding: 0, transactions: 1 }), "unpaid", /payment is recorded/);
      await blocked("paid in the CRM", await ready(tx, { payment: "SUCCESS" }), "unpaid", /payment is recorded/);
      await blocked("prepaid", await ready(tx, { mode: "PREPAID" }), "cod", /Not a COD order/);
      await blocked("refunded", await ready(tx, {}, { refunded: 5000 }), "no_refund", /refund/);
    });
  });

  it("courier gate: an order already given a courier / AWB, not COD, no longer NEW, two matches, or an unreachable Shiprocket all BLOCK; no Shiprocket order yet is allowed", async () => {
    await inRollback(async (tx) => {
      await blocked("AWB assigned", await ready(tx, {}, {}, [sr({ totalCents: 69900, awb: "SF123", courier: "Shadowfax" })]), "courier", /already has a courier/);
      await blocked("prepaid in Shiprocket", await ready(tx, {}, {}, [sr({ totalCents: 69900, paymentMethod: "prepaid" })]), "courier", /not COD/);
      await blocked("status moved on", await ready(tx, {}, {}, [sr({ totalCents: 69900, status: "PICKUP SCHEDULED" })]), "courier", /already has a courier/);
      await blocked("two matches", await ready(tx, {}, {}, [sr({ totalCents: 69900 }), sr({ shiprocketOrderId: "2", totalCents: 69900 })]), "courier", /2 Shiprocket orders match/);
      await blocked("Shiprocket unreachable", await ready(tx, {}, {}, new Error("Shiprocket is not configured")), "courier", /could not be verified/);
      const none = await ready(tx, {}, {}, []);
      const p = await none.s.preview(none.w.as(none.w.admin, Role.ADMIN), none.w.order.id);
      assert.equal(p.canApply, true, "no Shiprocket order yet: nothing to disagree with");
    });
  });

  it("only an Admin or Manager can apply; a telecaller can review but is refused (403) and sees canApply false; another telecaller gets not-found; HR is refused", async () => {
    await inRollback(async (tx) => {
      const r = await ready(tx);
      const owner = r.w.as(r.w.asha, Role.SALESPERSON);
      const p = await r.s.preview(owner, r.w.order.id);
      assert.equal(p.canApply, false);
      assert.equal(p.canExecute, false);
      assert.ok(p.proposal, "the telecaller still sees the proposal");
      await assert.rejects(r.s.apply(owner, r.w.order.id, apply(p)), (e: any) => e.statusCode === 403);
      const other = await r.s.preview(r.w.as(r.w.bala, Role.SALESPERSON), r.w.order.id);
      assert.equal(other.comparable, true, "any telecaller who can open the order can review it");
      assert.equal(other.canApply, false);
      await assert.rejects(r.s.apply(r.w.as(r.w.bala, Role.SALESPERSON), r.w.order.id, apply(p)), (e: any) => e.statusCode === 403);
      await assert.rejects(r.s.preview(r.w.as(r.w.hr, Role.HR), r.w.order.id), (e: any) => e.statusCode === 403);
      await assert.rejects(r.s.preview(r.w.as(r.w.admin, Role.ADMIN), "00000000-0000-4000-8000-000000000000"), (e: any) => e.statusCode === 404 && /Order not found/.test(e.message));
      // a manager outside the order's team: may review, may not apply - and is told why instead of 'Order not found'
      const mgr = r.w.as(r.w.manager, Role.MANAGER);
      assert.equal((await r.s.preview(mgr, r.w.order.id)).comparable, true);
      await assert.rejects(r.s.apply(mgr, r.w.order.id, apply(p)), (e: any) => e.statusCode === 403 && /you can only change orders/.test(e.message) && !/Order not found/.test(e.message));
    });
  });

  it("explicit confirmation: confirm must be true and the typed total must equal the corrected total; the validator rejects a malformed total", async () => {
    await inRollback(async (tx) => {
      const r = await ready(tx);
      const admin = r.w.as(r.w.admin, Role.ADMIN);
      const p = await r.s.preview(admin, r.w.order.id);
      await assert.rejects(r.s.apply(admin, r.w.order.id, { stateToken: p.stateToken!, confirmTotal: "699.00", confirm: false }), (e: any) => e.statusCode === 400 && /Confirm/.test(e.message));
      await assert.rejects(r.s.apply(admin, r.w.order.id, apply(p, "649.00")), (e: any) => e.statusCode === 400 && /not the corrected total/.test(e.message));
      assert.ok(validateAmountCorrection({ stateToken: p.stateToken, confirmTotal: "six ninety nine", confirm: true }).error);
      assert.ok(validateAmountCorrection({ stateToken: p.stateToken, confirmTotal: "699.00" }).error);
      assert.ifError(validateAmountCorrection({ stateToken: "abcdefgh12", confirmTotal: "699.00", confirm: true }).error);
      assert.ok(r.f.docs.every((d) => !MUTATIONS.test(d)));
    });
  });

  it("a STALE comparison is refused: Shopify, or Shiprocket, changed after the preview", async () => {
    await inRollback(async (tx) => {
      const r = await ready(tx);
      const admin = r.w.as(r.w.admin, Role.ADMIN);
      const p = await r.s.preview(admin, r.w.order.id);
      r.shop.updatedAt += 1;
      await assert.rejects(r.s.apply(admin, r.w.order.id, apply(p)), (e: any) => e.statusCode === 409 && e.data?.code === "STALE_PREVIEW");
      const courier: ShiprocketOrderLookup[] = [sr({ totalCents: 69900 })];
      const s2 = svc(tx, r.f, courier);
      const p2 = await s2.preview(admin, r.w.order.id);
      courier[0]!.totalCents = 64900; // the courier amount changed after the preview
      await assert.rejects(s2.apply(admin, r.w.order.id, apply(p2)), (e: any) => e.statusCode === 409 && e.data?.code === "STALE_PREVIEW");
      assert.ok(r.f.docs.every((d) => !MUTATIONS.test(d)));
    });
  });
});

describe("Review & Correct Amount - execution safety", () => {
  const ready = async (tx: Prisma.TransactionClient, opts: Opts = {}) => {
    const w = await world(tx);
    const shop = baseShop({ lines: [{ variant: w.variantGid, qty: 1, price: 64900 }] });
    const f = fake(shop, opts);
    return { w, shop, f, s: svc(tx, f, [sr({ totalCents: 69900 })]), admin: w.as(w.admin, Role.ADMIN) };
  };

  it("two corrections at once: one is applied, the other is refused (409), and Shopify gets exactly one edit", async () => {
    await inRollback(async (tx) => {
      const r = await ready(tx, { delayMs: 12 });
      const p = await r.s.preview(r.admin, r.w.order.id);
      const results = await Promise.allSettled([r.s.apply(r.admin, r.w.order.id, apply(p)), r.s.apply(r.admin, r.w.order.id, apply(p))]);
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(((results.find((x) => x.status === "rejected") as PromiseRejectedResult).reason as any).statusCode, 409);
      assert.equal(r.f.docs.filter((d) => d === "crmFlavourEditCommit").length, 1);
      assert.equal(r.shop.shippingLines, 1);
    });
  });

  it("Shopify refusing the edit: the outcome is 'failed' with the reason, the failure is recorded, Shopify and the CRM are unchanged, the claim is released and a retry works", async () => {
    await inRollback(async (tx) => {
      const refuse = await ready(tx, { commitFails: true });
      const p = await refuse.s.preview(refuse.admin, refuse.w.order.id);
      const r = await refuse.s.apply(refuse.admin, refuse.w.order.id, apply(p));
      assert.equal(r.outcome, "failed");
      assert.match(r.message, /Shopify did not apply the edit: .*Access denied/);
      assert.deepEqual([refuse.shop.total, refuse.shop.shippingLines], [64900, 0]);
      const audit = await tx.activity.findMany({ where: { orderId: refuse.w.order.id } });
      assert.match(audit[0]!.title ?? "", /correction FAILED/);
      const stored = await tx.order.findUniqueOrThrow({ where: { id: refuse.w.order.id }, select: { totalAmount: true, metadata: true } });
      assert.equal((stored.metadata as any).orderEditClaimedAt, undefined);
      assert.equal((stored.metadata as any).amountReview, undefined, "no 'last corrected' stamp on a failure");
      assert.equal(stored.totalAmount.toString(), "699");
    });
  });

  it("read-back verification: an edit Shopify 'accepts' but does not show is reported as FAILED, never as success; a staged total that is not exactly +50.00 is never committed", async () => {
    await inRollback(async (tx) => {
      const noop = await ready(tx, { commitNoop: true });
      const p = await noop.s.preview(noop.admin, noop.w.order.id);
      const r = await noop.s.apply(noop.admin, noop.w.order.id, apply(p));
      assert.equal(r.outcome, "failed");
      assert.match(r.message, /re-read does not show/);
    });
    await inRollback(async (tx) => {
      const extra = await ready(tx, { stagedExtra: 1000 }); // Shopify would add tax: staged 709.00
      const p = await extra.s.preview(extra.admin, extra.w.order.id);
      const r = await extra.s.apply(extra.admin, extra.w.order.id, apply(p));
      assert.equal(r.outcome, "failed");
      assert.match(r.message, /was not committed/);
      assert.ok(!extra.f.docs.includes("crmFlavourEditCommit"));
      assert.equal(extra.shop.total, 64900);
    });
  });
});

describe("Review & Correct Amount - other differences are reviewed, not corrected", () => {
  const preview = async (tx: Prisma.TransactionClient, over: Parameters<typeof world>[1], shopOver: (w: Awaited<ReturnType<typeof world>>) => Partial<Shop>) => {
    const w = await world(tx, over);
    const f = fake(baseShop(shopOver(w)));
    return svc(tx, f, [sr({ totalCents: 69900 })]).preview(w.as(w.admin, Role.ADMIN), w.order.id);
  };

  it("quantity 2: 2 x 649 + 50 = 1348 vs Shopify 1298 is the same supported shipping case (after total 1348.00)", async () => {
    await inRollback(async (tx) => {
      const p = await preview(tx, { qty: 2 }, (w) => ({ lines: [{ variant: w.variantGid, qty: 2, price: 64900 }], total: 129800, outstanding: 129800 }));
      assert.equal(p.proposal?.after.total, "1348.00");
      assert.equal(p.proposal?.amount, "50.00");
    });
  });

  it("a discount, a tax, a different quantity or price, or an existing shipping line that differs: NO proposal - listed with the reason for manual review", async () => {
    await inRollback(async (tx) => {
      const discount = await preview(tx, {}, (w) => ({ lines: [{ variant: w.variantGid, qty: 1, price: 64900 }], discounts: 2000, total: 62900, outstanding: 62900 }));
      assert.equal(discount.proposal, null);
      assert.ok(discount.rows.find((r) => r.key === "discount")!.status === "DIFFERENT");
      assert.match(discount.manualReason!, /not corrected by this action/);
      const tax = await preview(tx, {}, (w) => ({ lines: [{ variant: w.variantGid, qty: 1, price: 64900 }], tax: 1000 }));
      assert.equal(tax.proposal, null);
      const qty = await preview(tx, {}, (w) => ({ lines: [{ variant: w.variantGid, qty: 2, price: 64900 }] }));
      assert.equal(qty.proposal, null);
      const price = await preview(tx, {}, (w) => ({ lines: [{ variant: w.variantGid, qty: 1, price: 59900 }], total: 59900, outstanding: 59900 }));
      assert.equal(price.proposal, null);
      assert.equal(price.rows.find((r) => r.key === "items")!.status, "DIFFERENT");
      const wrongLine = await preview(tx, {}, (w) => ({ lines: [{ variant: w.variantGid, qty: 1, price: 64900 }], shipping: 3000, shippingLines: 1, total: 67900, outstanding: 67900 }));
      assert.equal(wrongLine.proposal, null, "a shipping line already exists: changing it is manual");
    });
  });

  it("a prepaid order (shipping 0) or an order already in agreement has nothing to correct", async () => {
    await inRollback(async (tx) => {
      const prepaid = await preview(tx, { mode: "PREPAID", shipping: "0.00" }, (w) => ({ lines: [{ variant: w.variantGid, qty: 1, price: 64900 }] }));
      assert.equal(prepaid.proposal, null);
      assert.equal(prepaid.rows.every((r) => r.status === "SAME"), true);
      const agreed = await preview(tx, {}, (w) => ({ lines: [{ variant: w.variantGid, qty: 1, price: 64900 }], total: 69900, outstanding: 69900, shipping: 5000, shippingLines: 1 }));
      assert.equal(agreed.proposal, null);
    });
  });
});

describe("Shiprocket lookup parsing", () => {
  it("matches the channel order id EXACTLY (a search for 105195 never picks up 1051950), reads the COD amount in cents, and reports AWB / courier only when present", () => {
    const json = { data: [
      { id: 1, channel_order_id: "AWL105195", status: "NEW", payment_method: "cod", total: "649.00", shipments: [{ awb: "", courier: "" }] },
      { id: 2, channel_order_id: "AWL1051950", status: "NEW", payment_method: "cod", total: "100.00", shipments: [] },
      { id: 3, channel_order_id: "awl105195", status: "PICKUP SCHEDULED", payment_method: "prepaid", total: "699", shipments: [{ awb: "SF1", courier: "Shadowfax" }] },
    ] };
    const r = parseOrderLookups(json, "#AWL105195");
    assert.deepEqual(r.map((x) => [x.shiprocketOrderId, x.totalCents, x.awb, x.courier]), [["1", 64900, null, null], ["3", 69900, "SF1", "Shadowfax"]]);
    assert.deepEqual(parseOrderLookups({ data: [] }, "AWL1"), []);
  });
});
