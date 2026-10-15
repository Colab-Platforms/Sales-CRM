// Fastrr "Abandon Cart" deliveries driven through the REAL processor (record -> claim -> parse -> lead -> abandonment snapshot) into the order-prefill read the
// Create Order form uses. Every test runs in ONE transaction that is always rolled back. All payloads here are SYNTHETIC fixtures shaped like live deliveries.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { memoryStore } from "../integrations/integrations.testutil.js";
import { processAbandonmentEvent } from "./shiprocket.abandonment.processor.js";
import AbandonmentService from "../abandonment/abandonment.service.js";

class Rollback extends Error {}
type Db = Prisma.TransactionClient;
async function inRollback(fn: (tx: Db, runner: { $transaction: <T>(cb: (tx: Db) => Promise<T>) => Promise<T> }) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx, { $transaction: (cb) => cb(tx) }); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const ADDR = { first_name: "Priya", last_name: "Shah", phone: "9000000123", address1: "12 Rose Villa", address2: "MG Road", landmark: "Near Park", city: "Pune", state: "Maharashtra", zip: "411001", country: "India" };
const cart = (over: Record<string, unknown> = {}) => ({
  cart_id: `cart-${uid()}`, phone_number: "9000000123", email: "priya@example.invalid", first_name: "Priya", last_name: "Shah", total_price: "1398", currency: "INR", shipping_price: "49",
  source_name: "fastrr", latest_stage: "PAYMENT", updated_at: "2026-10-12 10:00:00",
  items: [{ product_id: "111", variant_id: "1001", sku: "TEA", name: "Herbal Tea", title: "100g", price: "449", quantity: 2, img_url: "https://i.example.invalid/t.png" }, { product_id: "222", sku: "GUM", name: "Sleep Gummies", price: "500", quantity: 1 }],
  shipping_address: ADDR, billing_address: ADDR, ...over,
});

async function world(tx: Db, runner: Parameters<typeof processAbandonmentEvent>[1]["runner"]) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const { store, rows } = memoryStore();
  let n = 0;
  const deliver = async (payload: unknown, id = uid()) => {
    const { id: eventId, duplicate } = await store.record({ eventType: "checkout.abandoned", externalEventId: id, payload, ignored: false });
    if (duplicate) return "duplicate" as const;
    return processAbandonmentEvent(eventId, { store, runner, now: () => new Date("2026-10-12T11:00:00Z") });
  };
  const svc = new AbandonmentService(tx as never, { bulkAssignManagers: async () => ({ assignedCount: 0 }), bulkAssignSalespersons: async () => ({ assignedCount: 0 }) } as never, null);
  const admUser = { id: admin.id, username: admin.username, role: Role.ADMIN };
  const abandonmentFor = (cartId: string) => tx.abandonment.findMany({ where: { referenceId: cartId }, select: { id: true, leadId: true, detectedAt: true, cartSnapshot: true } });
  const prefillFor = (abandonmentId: string) => svc.getOrderPrefill(admUser, abandonmentId);
  return { deliver, abandonmentFor, prefillFor, rows, tx, n: () => ++n };
}

describe("Fastrr abandon-cart deliveries through the processor", () => {
  it("a delivery creates the lead + abandonment and the saved cart flows to the order prefill (products, price hint, address)", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const c = cart();
      assert.equal(await w.deliver(c), "processed");
      const [ab] = await w.abandonmentFor(c.cart_id as string);
      assert.ok(ab);
      const p = await w.prefillFor(ab!.id);
      assert.equal(p.dataFrom, "saved_cart");
      assert.deepEqual(p.lines.map((l) => [l.name, l.quantity, l.websiteUnitPrice, l.variantTitle]), [["Herbal Tea", 2, "449", "100g"], ["Sleep Gummies", 1, "500", null]]);
      assert.equal(p.address?.pincode, "411001");
      assert.equal(p.address?.city, "Pune");
      assert.equal(p.totals.shipping, "49");
    });
  });

  it("an exact duplicate delivery is ignored; a re-delivery with different bytes for the same cart refreshes IN PLACE (one abandonment, no duplicated lines)", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const c = cart();
      const id = uid();
      assert.equal(await w.deliver(c, id), "processed");
      assert.equal(await w.deliver(c, id), "duplicate");
      assert.equal(await w.deliver({ ...c, latest_stage: "ORDER_SCREEN", updated_at: "2026-10-12 10:05:00" }), "processed");
      const rows = await w.abandonmentFor(c.cart_id as string);
      assert.equal(rows.length, 1, "one abandonment per cart");
      assert.equal((rows[0]!.cartSnapshot as any).lines.length, 2, "lines replaced, never appended");
    });
  });

  it("a later PARTIAL delivery (no address, no items) does not erase the captured address or products", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const c = cart();
      await w.deliver(c);
      assert.equal(await w.deliver({ cart_id: c.cart_id, phone_number: c.phone_number, updated_at: "2026-10-12 10:10:00" }), "processed");
      const [ab] = await w.abandonmentFor(c.cart_id as string);
      const p = await w.prefillFor(ab!.id);
      assert.equal(p.address?.pincode, "411001", "address kept");
      assert.equal(p.lines.length, 2, "products kept");
    });
  });

  it("a delivery that arrives OUT OF ORDER (older timestamp, different data) does not overwrite the newer cart, and the detected time does not move backwards", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const c = cart({ updated_at: "2026-10-12 12:00:00", shipping_address: { ...ADDR, city: "Nagpur", zip: "440001" } });
      await w.deliver(c);
      const [first] = await w.abandonmentFor(c.cart_id as string);
      assert.equal(await w.deliver({ ...c, updated_at: "2026-10-12 09:00:00", items: [{ name: "Stale Item", quantity: 7, price: "1" }], shipping_address: { ...ADDR, city: "Pune", zip: "411001" } }), "processed");
      const [after] = await w.abandonmentFor(c.cart_id as string);
      const p = await w.prefillFor(after!.id);
      assert.equal(p.address?.city, "Nagpur");
      assert.deepEqual(p.lines.map((l) => l.name), ["Herbal Tea", "Sleep Gummies"]);
      assert.equal(after!.detectedAt.getTime(), first!.detectedAt.getTime());
    });
  });

  it("two customers with the SAME products but different carts and addresses stay separate", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const a = cart();
      const b = cart({ phone_number: "9111111111", email: "rahul@example.invalid", first_name: "Rahul", last_name: "Verma", shipping_address: { first_name: "Rahul", address1: "9 Hill Rd", city: "Delhi", state: "Delhi", zip: "110001", phone: "9111111111" }, billing_address: null });
      await w.deliver(a);
      await w.deliver(b);
      const [aa] = await w.abandonmentFor(a.cart_id as string);
      const [bb] = await w.abandonmentFor(b.cart_id as string);
      assert.notEqual(aa!.leadId, bb!.leadId);
      const pa = await w.prefillFor(aa!.id);
      const pb = await w.prefillFor(bb!.id);
      assert.equal(pa.address?.city, "Pune");
      assert.equal(pb.address?.city, "Delhi");
      assert.ok(!JSON.stringify(pa).includes("Delhi") && !JSON.stringify(pb).includes("Pune"));
    });
  });

  it("a cart whose phone and email belong to two DIFFERENT leads attaches to the phone's lead, every time", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const byPhone = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Phone", mobile: "9000000123", normalizedMobile: "+919000000123" }, select: { id: true } });
      await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Email", email: "priya@example.invalid", normalizedEmail: "priya@example.invalid" }, select: { id: true } });
      const c = cart();
      await w.deliver(c);
      const [ab] = await w.abandonmentFor(c.cart_id as string);
      assert.equal(ab!.leadId, byPhone.id);
    });
  });

  it("a delivery with no usable contact, or with junk types, never creates an abandonment and never crashes the processor", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const before = await tx.abandonment.count();
      assert.equal(await w.deliver({ cart_id: "x1", phone_number: " ", email: "" }), "ignored");
      assert.equal(await w.deliver({ cart_id: "x2", phone_number: ["9"], email: {} }), "ignored");
      assert.equal(await tx.abandonment.count(), before);
      assert.notEqual(await w.deliver(cart({ cart_id: "x3", items: { not: "an array" }, shipping_address: "text", billing_address: 5, total_price: {}, discount_codes: "A" })), "failed");
      const [ab] = await w.abandonmentFor("x3");
      assert.deepEqual((await w.prefillFor(ab!.id)).lines, []);
    });
  });
});
