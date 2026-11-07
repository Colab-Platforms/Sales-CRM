// Ingestion of a re-entered checkout (isolated database, rolled-back transactions): refresh the canonical row, never merge different carts, keep the original id / owner / history, idempotent, 60-minute boundary.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { saveAbandonment } from "./shiprocket.abandonment.processor.js";
import type { ParsedAbandonment } from "./shiprocket.abandonment.mapper.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try { await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 }); } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
after(() => prisma.$disconnect());

const tag = randomUUID().slice(0, 8);
const phone = `+9198${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
const T0 = new Date("2020-03-10T06:00:00Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);
const ev = (externalId: string, m: number, over: Partial<ParsedAbandonment> = {}): ParsedAbandonment => ({
  externalId, firstName: `Re${tag}`, lastName: null, phone, email: null, cartValue: "499", currency: "INR", itemCount: (over.itemNames ?? ["Paan 60"]).length, itemNames: (over.itemNames ?? ["Paan 60"]).slice(0, 3), items: [], stage: null, abandonedAt: at(m), checkoutUrl: `https://store/?cart-resume-id=${externalId}`,
  location: null, lines: [], totals: { total: null, shipping: null, tax: null, discount: null, discountCodes: [] }, shippingAddress: null, billingAddress: null, sourceName: null, ...over,
});
const rows = (tx: Prisma.TransactionClient, leadId: string) => tx.abandonment.findMany({ where: { leadId, type: "CHECKOUT" }, orderBy: { detectedAt: "asc" } });

const full = (names: string[]) => names.map((name) => ({ productId: `p-${name}`, variantId: `v-${name}`, sku: `s-${name}`, name, quantity: 1 }));

describe("checkout re-entry at ingestion", () => {
  it("REGRESSION: same first three products and total value but a different fourth product stay separate checkouts (the full item list is compared, not the 3-name display field)", async () => {
    await inRollback(async (tx) => {
      const base = ["P1", "P2", "P3"];
      const a = await saveAbandonment(tx, ev("four-A", 0, { cartValue: "1996", itemNames: base, itemCount: 4, items: full([...base, "P4-Paan"]) }), at(0));
      const b = await saveAbandonment(tx, ev("four-B", 5, { cartValue: "1996", itemNames: base, itemCount: 4, items: full([...base, "P4-Gutka"]) }), at(5));
      assert.equal(b.created, true);
      assert.equal((await rows(tx, a.leadId)).length, 2);
      const again = await saveAbandonment(tx, ev("four-C", 8, { cartValue: "1996", itemNames: base, itemCount: 4, items: full([...base, "P4-Paan"]) }), at(8));
      assert.equal(again.created, false, "the genuinely identical 4-product cart is still a re-entry");
      assert.equal((await rows(tx, a.leadId)).length, 2);
    });
  });

  it("a genuine re-entry (same lead, items, value, within 60 min, new cart id) refreshes the canonical row: one row, original checkout id / detection time / owner kept, history appended", async () => {
    await inRollback(async (tx) => {
      const a = await saveAbandonment(tx, ev("cart-A", 0), at(0));
      assert.equal(a.created, true);
      const owner = await tx.user.create({ data: { name: "T", username: `t-${tag}-${randomUUID().slice(0, 4)}`, role: Role.SALESPERSON } });
      await tx.lead.update({ where: { id: a.leadId }, data: { ownerId: owner.id } });
      await tx.activity.create({ data: { leadId: a.leadId, type: "NOTE", title: "Called - will order tonight", description: "customer note" } });
      const b = await saveAbandonment(tx, ev("cart-B", 30), at(30));
      assert.deepEqual([b.leadId === a.leadId, b.created], [true, false], "not a new checkout");
      const list = await rows(tx, a.leadId);
      assert.equal(list.length, 1);
      assert.equal(list[0]!.referenceId, "cart-A", "the original checkout id is preserved");
      assert.equal(list[0]!.detectedAt.getTime(), at(0).getTime(), "the anchor time does not slide");
      assert.equal((await tx.lead.findUniqueOrThrow({ where: { id: a.leadId } })).ownerId, owner.id, "assignment kept");
      assert.equal(await tx.activity.count({ where: { leadId: a.leadId, title: "Called - will order tonight" } }), 1, "notes / history kept");
      assert.ok((await tx.activity.count({ where: { leadId: a.leadId, type: "ABANDONMENT" } })) >= 2, "the re-entry is recorded in the history");
    });
  });

  it("different value, different product, or a re-entry beyond 60 minutes stays a separate checkout; the boundary is 60 min inclusive", async () => {
    await inRollback(async (tx) => {
      const a = await saveAbandonment(tx, ev("c-1", 0), at(0));
      await saveAbandonment(tx, ev("c-2", 10, { cartValue: "998" }), at(10));
      await saveAbandonment(tx, ev("c-3", 12, { itemNames: ["Gutka 60"] }), at(12));
      assert.equal((await rows(tx, a.leadId)).length, 3);
      const exact = await saveAbandonment(tx, ev("c-4", 60), at(60));
      assert.equal(exact.created, false, "exactly 60 minutes after the canonical row is the same checkout");
      const after = await saveAbandonment(tx, ev("c-5", 61 + 60), at(121));
      assert.equal(after.created, true, "beyond the window from the (unmoved) canonical row is a new checkout");
      assert.equal((await rows(tx, a.leadId)).length, 4);
    });
  });

  it("chained re-entries do not slide the window: 0 -> 50 merges, 100 is a separate checkout", async () => {
    await inRollback(async (tx) => {
      const a = await saveAbandonment(tx, ev("k-1", 0), at(0));
      assert.equal((await saveAbandonment(tx, ev("k-2", 50), at(50))).created, false);
      assert.equal((await saveAbandonment(tx, ev("k-3", 100), at(100))).created, true);
      assert.equal((await rows(tx, a.leadId)).length, 2);
    });
  });

  it("repeated delivery of the same cart id is idempotent", async () => {
    await inRollback(async (tx) => {
      const a = await saveAbandonment(tx, ev("same-id", 0), at(0));
      for (let i = 0; i < 3; i++) assert.equal((await saveAbandonment(tx, ev("same-id", 0), at(0))).created, false);
      assert.equal((await rows(tx, a.leadId)).length, 1);
    });
  });

  it("a cart with no items or no value is never merged by the fallback", async () => {
    await inRollback(async (tx) => {
      const a = await saveAbandonment(tx, ev("n-1", 0, { itemNames: [] }), at(0));
      assert.equal((await saveAbandonment(tx, ev("n-2", 5, { itemNames: [] }), at(5))).created, true);
      await saveAbandonment(tx, ev("n-3", 6, { cartValue: null }), at(6));
      assert.equal((await saveAbandonment(tx, ev("n-4", 7, { cartValue: null }), at(7))).created, true);
      assert.equal((await rows(tx, a.leadId)).length, 4);
    });
  });
});
