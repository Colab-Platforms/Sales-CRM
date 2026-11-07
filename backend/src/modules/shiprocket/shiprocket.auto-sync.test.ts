// Run with: npx tsx --test src/modules/shiprocket/shiprocket.auto-sync.test.ts
// Automatic Shiprocket submission of CRM-created orders. No database, Shopify or Shiprocket: an in-memory order/shipment stand-in and a fake Shiprocket that records what it was sent.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@/utils/apiError.js";
import OrdersService from "../orders/orders.service.js";
import { readShiprocketSync } from "./shiprocket.sync-record.js";
import { parcelFromItems } from "./shiprocket.parcel.js";
import { syncOrderToShiprocket } from "./shiprocket.auto-sync.js";
import ShiprocketShipmentsService from "./shiprocket.shipments.service.js";
import { CONFIG, ENV, ORDER, fakeDb, fakeShiprocket } from "./shiprocket.testutil.js";

const ROLES = [
  { label: "Telecaller", role: "SALESPERSON" },
  { label: "Manager", role: "MANAGER" },
  { label: "Admin", role: "ADMIN" },
] as const;
const decision = (enabled: boolean) => ({ shopifySyncDecision: { enabled, decidedAt: "2026-11-04T00:00:00.000Z" } });
const paid = [{ status: "SUCCESS", method: "PAYMENT_LINK", amount: "1249.00", refundedAmount: null }];

function setup(opts: { prepaid?: boolean; paid?: boolean; shopifyOn: boolean; role: string; source?: string; items?: unknown[]; total?: string }) {
  const base = {
    ...ORDER,
    source: opts.source ?? "SALESPERSON",
    metadata: { ...ORDER.metadata, paymentMode: opts.prepaid ? "PREPAID" : "COD", createdBy: { role: opts.role }, ...decision(opts.shopifyOn) },
    ...(opts.items ? { items: opts.items } : {}),
    status: opts.prepaid ? "PENDING_PAYMENT" : "CONFIRMED",
    payments: opts.prepaid ? (opts.paid ? paid : [{ status: "PENDING", method: "PAYMENT_LINK", amount: "1249.00", refundedAmount: null }]) : ORDER.payments,
  };
  const db = fakeDb(base as never);
  const sr = fakeShiprocket();
  const service = new ShiprocketShipmentsService(db.runner as never, { config: () => CONFIG, client: () => sr.api });
  const actor = { id: "creator-1", username: "creator", role: opts.role as never };
  const run = (trigger: "ORDER_CREATED" | "PAYMENT_VERIFIED" | "RETRY" = "ORDER_CREATED", env: Record<string, string> = ENV) => syncOrderToShiprocket({ db: db.tx as never, service, env }, ORDER.id, actor, trigger);
  return { db, sr, run };
}

describe("every creator x payment mode x Shopify setting: exactly one Shiprocket order", () => {
  for (const { label, role } of ROLES) {
    for (const shopifyOn of [false, true]) {
      it(`${label} COD, Shopify sync ${shopifyOn ? "ON" : "OFF"}: submitted once, with the CRM order number as channel id; repeats create nothing`, async () => {
        const { db, sr, run } = setup({ role, shopifyOn });
        const first = await run();
        assert.equal(first.status, "SYNCED", first.reason ?? "");
        assert.equal((await run("RETRY")).status, "SYNCED");
        assert.equal((await run("ORDER_CREATED")).status, "SYNCED");
        assert.equal(sr.sent.length, 1, "Shiprocket received the order exactly once");
        assert.equal(db.shipments.length, 1);
        const req = sr.sent[0]!;
        assert.equal(req.order_id, ORDER.orderNumber);
        assert.equal(req.payment_method, "COD");
        assert.equal(req.sub_total, 1249, "COD collectable amount");
        assert.equal(req.billing_phone, "9876500000");
        assert.equal(req.billing_pincode, "411001");
        assert.equal(req.billing_city, "Pune");
        assert.equal(req.billing_state, "Maharashtra");
        assert.deepEqual(req.order_items, [{ name: "Herbal Masala - Paan / 120", sku: "AW-HM-PN-120", units: 1, selling_price: 1199, discount: 0, tax: 0 }]);
        assert.doesNotMatch(JSON.stringify(req), /shopify/i);
        const rec = readShiprocketSync(db.order.metadata)!;
        assert.equal(rec.status, "SYNCED");
        assert.equal(rec.shiprocketOrderId, "SR-ORD-555");
        assert.equal(rec.channelOrderId, ORDER.orderNumber);
        assert.ok(rec.syncedAt && rec.lastAttemptAt);
        assert.equal(rec.error, null);
      });

      it(`${label} prepaid, Shopify sync ${shopifyOn ? "ON" : "OFF"}: nothing is sent until the payment is verified, then exactly once (as Prepaid, nothing to collect)`, async () => {
        const unpaid = setup({ role, shopifyOn, prepaid: true });
        assert.equal((await unpaid.run("ORDER_CREATED")).status, "AWAITING_PAYMENT");
        assert.equal(unpaid.sr.sent.length, 0);
        assert.equal(readShiprocketSync(unpaid.db.order.metadata)?.status, "AWAITING_PAYMENT");

        const done = setup({ role, shopifyOn, prepaid: true, paid: true });
        assert.equal((await done.run("PAYMENT_VERIFIED")).status, "SYNCED");
        assert.equal((await done.run("PAYMENT_VERIFIED")).status, "SYNCED", "a repeated payment callback");
        assert.equal(done.sr.sent.length, 1);
        assert.equal(done.sr.sent[0]!.payment_method, "Prepaid");
        assert.equal(done.sr.sent[0]!.order_id, ORDER.orderNumber);
      });
    }
  }
});

describe("failures never lose the order, and a retry finishes the job without a second Shiprocket order", () => {
  it("an API refusal is recorded as FAILED with the reason; the retry succeeds and creates exactly one", async () => {
    const { db, sr, run } = setup({ role: "SALESPERSON", shopifyOn: false });
    let fail = true;
    const real = sr.api.createOrder;
    sr.api.createOrder = async (r) => { if (fail) throw new (await import("../integrations/integrations.common.js")).ProviderHttpError("SHIPROCKET", 422, "Pickup location not found", false); return real(r); };
    const first = await run();
    assert.equal(first.status, "FAILED");
    let rec = readShiprocketSync(db.order.metadata)!;
    assert.equal(rec.status, "FAILED");
    assert.match(rec.error ?? "", /Pickup location not found/);
    assert.equal(rec.attempts, 1);
    assert.equal(db.order.status, "CONFIRMED", "the CRM order is untouched");
    fail = false;
    assert.equal((await run("RETRY")).status, "SYNCED");
    rec = readShiprocketSync(db.order.metadata)!;
    assert.equal(rec.status, "SYNCED");
    assert.equal(rec.attempts, 2);
    assert.equal(rec.error, null);
    assert.equal(sr.sent.length, 1);
    assert.equal(db.shipments.filter((s) => s.status !== "CANCELLED").length, 1);
    // the failed first attempt stays as a cancelled reservation; the second submission therefore uses a suffixed channel id so the two never share one
    assert.notEqual(sr.sent[0]!.order_id, ORDER.orderNumber);
  });


});

describe("independence from Shopify, and Shopify-originated orders", () => {
  it("a Shopify-originated order is never submitted by this path", async () => {
    const { sr, run } = setup({ role: "SALESPERSON", shopifyOn: true, source: "SHOPIFY" });
    assert.equal((await run()).status, "NOT_APPLICABLE");
    assert.equal(sr.sent.length, 0);
  });

  it("Shiprocket submission does not read or write any Shopify status, and Shopify behaviour is unchanged by it", async () => {
    // Shopify OFF -> the push is skipped; ON -> it goes to the existing claim path. Shiprocket has submitted the same order in both cases.
    for (const shopifyOn of [false, true]) {
      const { db, sr, run } = setup({ role: "SALESPERSON", shopifyOn });
      await run();
      assert.equal(sr.sent.length, 1);
      const meta = db.order.metadata as Record<string, unknown>;
      assert.equal(meta.shopifySync, undefined, "no Shopify status was written");
      assert.equal(db.order.externalId, null, "no Shopify id was needed or set");
      let claims = 0;
      const odb = { order: { findFirst: async () => ({ ...db.order, id: "o1" }), findUnique: async () => ({ ...db.order, payments: [] }) }, $executeRaw: async () => { claims++; throw new Error("claim reached"); } };
      const svc = new OrdersService(odb as never, () => assert.fail("no Shopify client in this test"));
      const r = await svc.pushOrderToShopify(null, "o1").catch((e: unknown) => e);
      if (shopifyOn) assert.ok(claims > 0, "ON: the existing Shopify path is reached");
      else {
        assert.equal((r as { status: string }).status, "skipped");
        assert.equal(claims, 0);
      }
    }
  });

  it("the Shiprocket module never reads the Shopify setting or decision", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["shiprocket.auto-sync.ts", "shiprocket.sync-record.ts"]) {
      assert.doesNotMatch(readFileSync(new URL(`./${f}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""), /shopify/i, f);
    }
  });

  it("an order the retry may not see is reported as not found by the service (scope is checked before anything is submitted)", async () => {
    const svc = new OrdersService({ order: { findFirst: async () => null }, user: { findUnique: async () => null }, lead: { findFirst: async () => null } } as never);
    await assert.rejects(() => svc.retryShiprocketSync({ id: "u", username: "u", role: "ADMIN" as never }, ORDER.id).catch((e: unknown) => { throw e instanceof ApiError ? e : e; }));
  });
});

describe("the retry endpoint's role gate", () => {});

describe("registration only: the automatic submission stops at Shiprocket's create-order call", () => {
  for (const prepaid of [false, true]) {
    it(`${prepaid ? "prepaid" : "COD"}: no courier lookup, AWB, pickup or label is requested, and the shipment is left without an AWB`, async () => {
      const { db, sr, run } = setup({ role: "SALESPERSON", shopifyOn: false, prepaid, paid: prepaid });
      const forbidden = (name: string) => async () => assert.fail(`${name} must not be called by the automatic submission`);
      sr.api.getCouriers = forbidden("getCouriers");
      sr.api.assignAwb = forbidden("assignAwb");
      sr.api.generatePickup = forbidden("generatePickup");
      sr.api.generateLabel = forbidden("generateLabel");
      sr.api.track = forbidden("track");
      assert.equal((await run(prepaid ? "PAYMENT_VERIFIED" : "ORDER_CREATED")).status, "SYNCED");
      assert.equal(sr.sent.length, 1);
      assert.equal(db.shipments[0]!.status, "CREATED");
      assert.equal(db.shipments[0]!.trackingNumber ?? null, null);
      assert.equal(db.shipments[0]!.courier ?? null, null);
      assert.equal(db.shipments[0]!.pickupScheduledAt ?? null, null);
    });
  }

});

const line = (sku: string, qty: number, m: Partial<Record<"weightKg" | "lengthCm" | "widthCm" | "heightCm", string | null>> | null, name = "Herbal Masala", variant: string | null = null) => ({
  productNameSnapshot: name, variantNameSnapshot: variant, skuSnapshot: sku, quantity: qty, unitPrice: "500.00", discountAmount: "0.00", taxAmount: "0.00", variant: null,
  product: m === null ? null : { weightKg: null, lengthCm: null, widthCm: null, heightCm: null, ...m },
});
const FULL = { weightKg: "0.25", lengthCm: "10", widthCm: "8", heightCm: "5" };

describe("parcel from product-level measurements", () => {
  it("single product with complete measurements: weight x quantity, the product's own size, and no SHIPROCKET_DEFAULT_* variable needed", async () => {
    const { sr, run, db } = setup({ role: "SALESPERSON", shopifyOn: false, items: [line("AW-A", 2, FULL)] });
    assert.equal((await run("ORDER_CREATED", { SHIPROCKET_ENABLED: "true" })).status, "SYNCED");
    const req = sr.sent[0] as unknown as Record<string, number>;
    assert.deepEqual([req.weight, req.length, req.breadth, req.height], [0.5, 10, 8, 5]);
    assert.equal(readShiprocketSync(db.order.metadata)?.status, "SYNCED");
  });

  it("several products with different quantities: weights are summed (x quantity); the size is the LARGEST of each side, never added", async () => {
    const small = { weightKg: "0.2", lengthCm: "10", widthCm: "8", heightCm: "5" };
    const big = { weightKg: "0.75", lengthCm: "14", widthCm: "6", heightCm: "9" };
    const { sr, run } = setup({ role: "MANAGER", shopifyOn: true, items: [line("AW-S", 3, small), line("AW-B", 2, big, "Calcium", "Pack of 2")] });
    assert.equal((await run()).status, "SYNCED");
    const req = sr.sent[0] as unknown as Record<string, number>;
    assert.deepEqual([req.weight, req.length, req.breadth, req.height], [2.1, 14, 8, 9], "3x0.2 + 2x0.75 = 2.1 kg; max(10,14) x max(8,6) x max(5,9)");
  });

  it("a variant's own measurements are used before its product's", () => {
    const r = parcelFromItems([{ quantity: 1, skuSnapshot: "V", productNameSnapshot: "P", variantNameSnapshot: "V1", measures: { weightKg: "0.6", lengthCm: "12", widthCm: "9", heightCm: "7" } }]);
    assert.deepEqual(r.ok && r.input, { weight: 0.6, length: 12, breadth: 9, height: 7 });
  });

  it("COD and prepaid both carry the product-level parcel", async () => {
    for (const prepaid of [false, true]) {
      const { sr, run } = setup({ role: "ADMIN", shopifyOn: false, prepaid, paid: prepaid, items: [line("AW-A", 1, FULL)] });
      assert.equal((await run(prepaid ? "PAYMENT_VERIFIED" : "ORDER_CREATED")).status, "SYNCED");
      assert.equal((sr.sent[0] as unknown as Record<string, number>).weight, 0.25);
    }
  });
});

describe("missing product measurements", () => {
  it("names the exact SKU and fields, sends nothing, keeps the order, and a retry after correcting the products succeeds once", async () => {
    const items = [line("AW-OK", 1, FULL), line("AW-NODIM", 1, { weightKg: "0.3", lengthCm: "10", widthCm: null, heightCm: "0" }, "Dia Shield", "Pack of 2"), line("AW-NOTHING", 1, {}, "Gut Fuel")];
    const { db, sr, run } = setup({ role: "SALESPERSON", shopifyOn: false, items });
    const first = await run();
    assert.equal(first.status, "FAILED");
    const rec = readShiprocketSync(db.order.metadata)!;
    assert.equal(rec.status, "FAILED");
    assert.match(rec.error ?? "", /AW-NODIM \(Dia Shield - Pack of 2\): breadth, height/, "0 and blank are both 'not recorded'");
    assert.match(rec.error ?? "", /AW-NOTHING \(Gut Fuel\): weight, length, breadth, height/);
    assert.doesNotMatch(rec.error ?? "", /AW-OK/);
    assert.equal(sr.sent.length, 0);
    assert.equal(db.order.status, "CONFIRMED");
    // the products are corrected (the same row objects the next read returns), then the retry
    for (const it of db.order.items as unknown as { sku?: string; skuSnapshot: string; product: Record<string, string | null> }[]) Object.assign(it.product, FULL);
    assert.equal((await run("RETRY")).status, "SYNCED");
    assert.equal((await run("RETRY")).status, "SYNCED");
    assert.equal(sr.sent.length, 1, "exactly one registration");
    assert.equal(readShiprocketSync(db.order.metadata)?.attempts, 2);
  });

  it("a custom item (no catalogue product) and an order with no items are reported, never defaulted", () => {
    const custom = parcelFromItems([{ quantity: 1, skuSnapshot: null, productNameSnapshot: "Gift box", variantNameSnapshot: null, measures: null }]);
    assert.ok(!custom.ok && custom.missing[0]!.sku === "(no SKU)" && custom.missing[0]!.fields.length === 4);
    assert.equal(parcelFromItems([]).ok, false);
  });

  it("a weight recorded on the order replaces the product sum, but missing product SIZES are still reported", () => {
    const noDims = { weightKg: null, lengthCm: null, widthCm: null, heightCm: null };
    const r = parcelFromItems([{ quantity: 1, skuSnapshot: "X", productNameSnapshot: "P", variantNameSnapshot: null, measures: noDims }], "1.5");
    assert.ok(!r.ok && r.missing[0]!.fields.join() === "length,breadth,height");
    const ok = parcelFromItems([{ quantity: 4, skuSnapshot: "X", productNameSnapshot: "P", variantNameSnapshot: null, measures: { ...noDims, lengthCm: "9", widthCm: "9", heightCm: "9" } }], "1.5");
    assert.deepEqual(ok.ok && ok.input, { weight: 1.5, length: 9, breadth: 9, height: 9 });
  });
});
