// The exact reported case, with synthetic data: customer 7898886844, one Aayush Wellness Herbal Masala (same variant x1), Rs 499, abandoned at 15:15 and 15:16 IST under two different Fastrr cart ids.
// Isolated database, rolled-back transaction. Ingestion must keep ONE row and not touch the owner; legacy duplicate rows (stored before the fix) must show as ONE row in the Abandoned Leads list, its total and "select all".
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import AbandonmentService from "./abandonment.service.js";
import { validateListAbandonmentsQuery } from "./abandonment.validators.js";
import { saveAbandonment } from "../shiprocket/shiprocket.abandonment.processor.js";
import type { ParsedAbandonment } from "../shiprocket/shiprocket.abandonment.mapper.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try { await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 }); } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
after(() => prisma.$disconnect());

const NAME = "Aayush Wellness Herbal Masala - Paan Masala Flavour / 60 - Pouches";
const line = { productId: "8009941287101", variantId: "45082739572925", sku: "AW-HM-PN-60", name: NAME, quantity: 1 };
const T = new Date("2020-05-05T09:45:11Z"); // 15:15 IST
const ev = (id: string, secs: number, over: Partial<ParsedAbandonment> = {}): ParsedAbandonment => ({
  externalId: id, firstName: "Customer", lastName: null, phone: "7898886844", email: null, cartValue: "499", currency: "INR", itemCount: 1, itemNames: [NAME], items: [line], stage: null,
  abandonedAt: new Date(T.getTime() + secs * 1000), checkoutUrl: `https://store/?cart-resume-id=${id}`, location: null, lines: [], totals: { total: null, shipping: null, tax: null, discount: null, discountCodes: [] },
  shippingAddress: null, billingAddress: null, sourceName: null, ...over,
});
const stubLeadService = { bulkAssignManagers: async () => ({ assignedCount: 0 }), bulkAssignSalespersons: async () => ({ assignedCount: 0 }), bulkAssignSalespersonsByStaff: async () => ({ assignedCount: 0 }), bulkUpdateStatus: async () => ({ updatedCount: 0 }) };

describe("reported case: two Fastrr events 75 seconds apart for the same cart", () => {
  it("ingestion keeps ONE row and reports the second event as not-new (the automatic assignment is gated on 'created', so it runs once); the canonical lead's owner is untouched", async () => {
    await inRollback(async (tx) => {
      const first = await saveAbandonment(tx, ev("6ae1c420cdc86d4c74044944", 0), T);
      const owner = await tx.user.create({ data: { name: "Dheeraj", username: `d-${randomUUID().slice(0, 8)}`, role: Role.SALESPERSON } });
      await tx.lead.update({ where: { id: first.leadId }, data: { ownerId: owner.id } });
      const second = await saveAbandonment(tx, ev("6ae1c46d482f4e13d256885d", 75), new Date(T.getTime() + 75_000));
      assert.deepEqual([first.created, second.created, second.leadId === first.leadId], [true, false, true]);
      assert.equal(await tx.abandonment.count({ where: { leadId: first.leadId } }), 1);
      assert.equal((await tx.lead.findUniqueOrThrow({ where: { id: first.leadId } })).ownerId, owner.id);
      assert.equal(await tx.leadAssignment.count({ where: { leadId: first.leadId } }), 0, "ingestion itself creates no assignment");
    });
  });

  it("a different quantity or product from the same customer is a separate checkout", async () => {
    await inRollback(async (tx) => {
      const a = await saveAbandonment(tx, ev("c-1", 0), T);
      assert.equal((await saveAbandonment(tx, ev("c-2", 60, { items: [{ ...line, quantity: 2 }], cartValue: "998" }), new Date(T.getTime() + 60_000))).created, true);
      assert.equal((await saveAbandonment(tx, ev("c-3", 70, { items: [{ ...line, variantId: "other", name: "Gutka" }], itemNames: ["Gutka"] }), new Date(T.getTime() + 70_000))).created, true);
      assert.equal(await tx.abandonment.count({ where: { leadId: a.leadId } }), 3);
    });
  });

  it("LEGACY rows already stored as two (deployed before the fix): the Abandoned Leads list, its total and select-all show ONE row - the earlier, canonical one - and nothing is deleted", async () => {
    await inRollback(async (tx) => {
      const lead = await tx.lead.create({ data: { leadNumber: `L-${randomUUID().slice(0, 8)}`, firstName: "Legacy", mobile: "7898886844" } });
      const snapshot = (id: string) => ({ itemNames: [NAME], itemCount: 1, items: [line], cartValue: "499", currency: "INR", checkoutUrl: `https://store/?cart-resume-id=${id}` }) as Prisma.InputJsonValue;
      const canonical = await tx.abandonment.create({ data: { leadId: lead.id, type: "CHECKOUT", referenceId: "6ae1c420cdc86d4c74044944", detectedAt: T, cartSnapshot: snapshot("6ae1c420cdc86d4c74044944") } });
      const duplicate = await tx.abandonment.create({ data: { leadId: lead.id, type: "CHECKOUT", referenceId: "6ae1c46d482f4e13d256885d", detectedAt: new Date(T.getTime() + 75_000), cartSnapshot: snapshot("6ae1c46d482f4e13d256885d") } });
      const svc = new AbandonmentService(tx as never, stubLeadService as never, null);
      const admin = await tx.user.create({ data: { name: "A", username: `a-${randomUUID().slice(0, 8)}`, role: Role.ADMIN } });
      const who = { id: admin.id, username: admin.username, role: Role.ADMIN } as never;
      const parsed = validateListAbandonmentsQuery({ dateRange: "all", pageSize: "100", search: "Legacy" });
      assert.ifError(parsed.error);
      const r = await svc.listAbandonments(who, parsed.value!);
      assert.deepEqual(r.items.map((i) => i.id), [canonical.id]);
      assert.equal(r.pagination.totalItems, 1);
      assert.ok(!r.items.some((i) => i.id === duplicate.id));
      const ids = await svc.listMatchingIds(who, parsed.value!);
      assert.deepEqual([ids.total, ids.ids], [1, [canonical.id]]);
      assert.equal(await tx.abandonment.count({ where: { leadId: lead.id } }), 2, "nothing was deleted or merged");
    });
  });
});
