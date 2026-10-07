// Items filter against the real schema: JSON containment in Postgres, combined with the other filters, scope, counts, and the
// hand-off to the existing bulk-assign. Each test runs in ONE transaction that is always rolled back.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AbandonmentType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import AbandonmentService from "./abandonment.service.js";
import { encodeItemKeys } from "./abandonment.items.js";
import { validateListAbandonmentsQuery } from "./abandonment.validators.js";

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
const HPM = { sku: "T-HPM", name: "Herbal Paan Masala" };
const SG = { sku: "T-SG", name: "Sleep Gummies" };
const VJ = { sku: "T-VJ", name: "Varjasaki" };
const snap = (...lines: { sku: string; name: string }[]) => ({ cartValue: "499.00", currency: "INR", itemCount: lines.length, itemNames: lines.map((l) => l.name), items: lines.map((l) => ({ productId: null, variantId: null, sku: l.sku, name: l.name, quantity: 1 })), stage: null, checkoutUrl: null });
const keyOf = (l: { sku: string; name: string }) => `s:${l.sku}|${l.name}`;

async function world(tx: Prisma.TransactionClient) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const manager = await tx.user.create({ data: { name: "TL", username: `m-${uid()}`, role: Role.MANAGER } });
  const other = await tx.user.create({ data: { name: "Other TL", username: `o-${uid()}`, role: Role.MANAGER } });
  const vini = await tx.user.create({ data: { name: "Vini", username: `v-${uid()}`, role: Role.SALESPERSON } });
  let n = 0;
  const cart = async (cartSnapshot: unknown, lead: { managerId?: string | null; ownerId?: string | null; workingStatus?: "NEW" | "RINGING" } = {}, detectedAt = new Date()) => {
    n += 1;
    const l = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: `Cust${n}`, mobile: `90000${String(n).padStart(5, "0")}`, normalizedMobile: `+9190000${String(n).padStart(5, "0")}`, assignedManagerId: lead.managerId ?? null, ownerId: lead.ownerId ?? null, workingStatus: lead.workingStatus ?? "NEW" }, select: { id: true } });
    const a = await tx.abandonment.create({ data: { leadId: l.id, type: AbandonmentType.CHECKOUT, detectedAt, cartSnapshot: cartSnapshot as Prisma.InputJsonValue }, select: { id: true, leadId: true } });
    return { ...a, firstName: `Cust${n}` };
  };
  const assigned: string[] = [];
  const stub = { bulkAssignManagers: async () => ({ assignedCount: 0 }), bulkAssignSalespersons: async (_m: string, body: { leadIds: string[] }) => { assigned.push(...body.leadIds); return { assignedCount: body.leadIds.length }; } } as never;
  const svc = new AbandonmentService(tx as never, stub);
  const as = (u: { id: string; username: string; role: Role }) => ({ id: u.id, username: u.username, role: u.role });
  const list = (user: typeof admin, q: Record<string, string> = {}) => {
    const parsed = validateListAbandonmentsQuery(q);
    assert.ifError(parsed.error);
    return svc.listAbandonments(as(user), parsed.value!);
  };
  return { admin, manager, other, vini, cart, svc, as, list, assigned };
}
const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id).sort();

describe("Abandoned checkout Items filter", () => {
  it("options come from real cart data (name + SKU + count), searchable, and are scoped to what the viewer can see", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.cart(snap(HPM, SG), { managerId: w.manager.id });
      await w.cart(snap(HPM), { managerId: w.manager.id });
      await w.cart(snap(VJ), { managerId: w.other.id });
      const all = (await w.svc.listItemOptions(w.as(w.admin))).items.filter((o) => o.sku?.startsWith("T-"));
      assert.deepEqual(all.map((o) => [o.name, o.sku, o.count]), [["Herbal Paan Masala", "T-HPM", 2], ["Sleep Gummies", "T-SG", 1], ["Varjasaki", "T-VJ", 1]]);
      const mine = (await w.svc.listItemOptions(w.as(w.manager))).items;
      assert.deepEqual(mine.map((o) => o.name), ["Herbal Paan Masala", "Sleep Gummies"], "a manager only sees products of their own queue");
      assert.deepEqual((await w.svc.listItemOptions(w.as(w.admin), "gumm")).items.map((o) => o.name), ["Sleep Gummies"]);
      assert.deepEqual((await w.svc.listItemOptions(w.as(w.manager), "zzz")).items, []);
    });
  });
  it("single product, multiple products (OR), no match, and an empty selection", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart(snap(HPM, SG), { managerId: w.manager.id });
      const b = await w.cart(snap(HPM), { managerId: w.manager.id });
      const c = await w.cart(snap(SG), { managerId: w.manager.id });
      const d = await w.cart(snap(VJ), { managerId: w.manager.id });
      assert.deepEqual(ids(await w.list(w.manager, { items: encodeItemKeys([keyOf(HPM)]) })), [a.id, b.id].sort());
      assert.deepEqual(ids(await w.list(w.manager, { items: encodeItemKeys([keyOf(HPM), keyOf(SG)]) })), [a.id, b.id, c.id].sort(), "OR, and a cart holding both is listed once");
      assert.deepEqual(ids(await w.list(w.manager, { items: encodeItemKeys([keyOf(VJ)]) })), [d.id]);
      const none = await w.list(w.manager, { items: encodeItemKeys(["s:NOPE|Nothing"]) });
      assert.deepEqual([none.items.length, none.pagination.totalItems], [0, 0]);
      assert.equal((await w.list(w.manager, {})).items.length, 4, "no items filter = unchanged list");
    });
  });
  it("matches on product id / variant id / SKU, and older name-only carts of the same product", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const byProduct = await w.cart({ ...snap(SG), items: [{ productId: "P-9", variantId: "V-9", sku: null, name: "Sleep Gummies", quantity: 1 }] }, { managerId: w.manager.id });
      const legacy = await w.cart({ cartValue: "10", itemNames: ["Sleep Gummies"] }, { managerId: w.manager.id });
      const decoy = await w.cart({ ...snap(SG), items: [{ productId: "P-1", variantId: "V-1", sku: null, name: "Another", quantity: 1 }], itemNames: ["Another"] }, { managerId: w.manager.id });
      assert.deepEqual(ids(await w.list(w.manager, { items: encodeItemKeys(["p:P-9|Sleep Gummies"]) })), [byProduct.id, legacy.id].sort());
      assert.deepEqual(ids(await w.list(w.manager, { items: encodeItemKeys(["v:V-9"]) })), [byProduct.id]);
      assert.deepEqual(ids(await w.list(w.manager, { items: encodeItemKeys(["p:P-1"]) })), [decoy.id]);
      assert.deepEqual(ids(await w.list(w.manager, { items: encodeItemKeys(["n:Sleep Gummies"]) })), [byProduct.id, legacy.id].sort());
    });
  });
  it("works together with lead status, assignee, date and search; pagination/count reflect the filtered set", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const now = new Date();
      const old = new Date(now.getTime() - 20 * 86_400_000);
      const hit = await w.cart(snap(HPM), { managerId: w.manager.id, workingStatus: "NEW" }, now);
      await w.cart(snap(HPM), { managerId: w.manager.id, workingStatus: "RINGING" }, now); // wrong status
      await w.cart(snap(HPM), { managerId: w.manager.id, ownerId: w.vini.id, workingStatus: "NEW" }, now); // already assigned
      await w.cart(snap(HPM), { managerId: w.manager.id, workingStatus: "NEW" }, old); // too old
      await w.cart(snap(SG), { managerId: w.manager.id, workingStatus: "NEW" }, now); // other product
      const combined = await w.list(w.manager, { items: encodeItemKeys([keyOf(HPM)]), workingStatus: "NEW", assignment: "ASSIGNED_TO_MANAGER", dateFrom: new Date(now.getTime() - 7 * 86_400_000).toISOString(), search: hit.firstName });
      assert.deepEqual(ids(combined), [hit.id]);
      const paged = await w.list(w.manager, { items: encodeItemKeys([keyOf(HPM)]), pageSize: "2", page: "2" });
      assert.deepEqual([paged.items.length, paged.pagination.totalItems, paged.pagination.totalPages], [2, 4, 2]);
      const bySalesperson = await w.list(w.manager, { items: encodeItemKeys([keyOf(HPM)]), salespersonId: w.vini.id });
      assert.equal(bySalesperson.pagination.totalItems, 1);
    });
  });
  it("assignment after filtering: every match (beyond one page) goes through the EXISTING bulk-assign, and nothing outside the filter or scope does", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const mine = [await w.cart(snap(HPM), { managerId: w.manager.id }), await w.cart(snap(HPM, SG), { managerId: w.manager.id }), await w.cart(snap(HPM), { managerId: w.manager.id })];
      const wrongProduct = await w.cart(snap(SG), { managerId: w.manager.id });
      const theirs = await w.cart(snap(HPM), { managerId: w.other.id });
      const q = validateListAbandonmentsQuery({ items: encodeItemKeys([keyOf(HPM)]), pageSize: "2" }).value!;
      const selected = await w.svc.listMatchingIds(w.as(w.manager), q);
      assert.deepEqual([selected.ids.slice().sort(), selected.total, selected.capped], [mine.map((m) => m.id).sort(), 3, false], "all 3 matches, although the page size is 2");
      const result = await w.svc.bulkAssignSalesperson(w.as(w.manager), { abandonmentIds: selected.ids, method: "MANUAL", salespersonId: w.vini.id });
      assert.equal(result.assignedCount, 3);
      assert.deepEqual(w.assigned.slice().sort(), mine.map((m) => m.leadId).sort());
      assert.ok(!w.assigned.includes(wrongProduct.leadId) && !w.assigned.includes(theirs.leadId));
      // The manager cannot smuggle in someone else's checkout.
      await assert.rejects(() => w.svc.bulkAssignSalesperson(w.as(w.manager), { abandonmentIds: [...selected.ids, theirs.id], method: "MANUAL", salespersonId: w.vini.id }), (e: any) => e.statusCode === 404);
      // A salesperson-scoped viewer only ever matches their own leads.
      assert.equal((await w.svc.listMatchingIds(w.as(w.vini), q)).total, 0);
    });
  });
});
