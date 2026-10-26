// Customer search (name / phone) against the real schema, for each role. The search is applied by the SERVER to the whole authorised result set: totals and pages agree, and a search only ever NARROWS
// what the caller's lead scope already allows. Each test runs in ONE transaction that is always rolled back.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { LifecycleStage, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import CustomersService from "./customers.service.js";
import { customerSearchWhere, phoneSearchVariants } from "./customers.filters.js";

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

async function world(tx: Prisma.TransactionClient) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const manager = await tx.user.create({ data: { name: "Manager", username: `m-${uid()}`, role: Role.MANAGER } });
  const asha = await tx.user.create({ data: { name: "Asha T", username: `t1-${uid()}`, role: Role.SALESPERSON } });
  const bala = await tx.user.create({ data: { name: "Bala T", username: `t2-${uid()}`, role: Role.SALESPERSON } });
  const group = await tx.group.create({ data: { name: `Team-${uid()}`, managerId: manager.id } });
  await tx.groupMember.create({ data: { groupId: group.id, userId: asha.id, joinedAt: new Date(), isActive: true } });
  const tag = uid().slice(0, 8);
  let n = 0;
  const customer = async (first: string, last: string | null, mobile: string, ownerId: string | null) => {
    n += 1;
    const digits = mobile.replace(/\D/g, "").slice(-10);
    return tx.lead.create({
      data: { leadNumber: `C-${tag}-${n}`, firstName: first, lastName: last, mobile, normalizedMobile: `+91${digits}`, ownerId, lifecycleStage: LifecycleStage.CUSTOMER },
      select: { id: true, leadNumber: true },
    });
  };
  const svc = new CustomersService(tx);
  const names = async (user: { id: string; username: string }, role: Role, search: string, page = 1, pageSize = 20) => {
    const r = await svc.listCustomers(as(user, role), { page, pageSize, search });
    return { names: r.items.map((i) => i.name), total: r.pagination.totalItems };
  };
  return { admin, manager, asha, bala, customer, svc, names, tag };
}

describe("customer search - the where-builder", () => {
  it("phone search variants: typed number, national number without +91 / 91 / 0; text is not a phone", () => {
    assert.deepEqual(phoneSearchVariants("98765 43210"), ["9876543210"]);
    assert.deepEqual(phoneSearchVariants("+91-98765-43210").sort(), ["919876543210", "9876543210"]);
    assert.deepEqual(phoneSearchVariants("09876543210").sort(), ["09876543210", "9876543210"]);
    assert.deepEqual(phoneSearchVariants("98"), [], "too short to be a phone search");
    assert.deepEqual(phoneSearchVariants("Asha 98765"), []);
  });
  it("a multi-word name needs every word to match", () => {
    const where = customerSearchWhere("  Asha   Kumar ") as { OR: { AND?: unknown[] }[] };
    const and = where.OR.find((c) => c.AND)!.AND!;
    assert.equal(and.length, 2);
  });
});

describe("customer search - by role", () => {
  it("finds a customer by full phone number however it is typed, by a partial number, and by first name, last name and full name", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.customer("Priya", "Shah", "98765 43210", w.asha.id);
      await w.customer("Rohan", "Mehta", "9123456780", w.asha.id);
      for (const q of ["9876543210", "98765 43210", "+91 98765-43210", "919876543210", "09876543210", "98765", "6543210"]) {
        assert.deepEqual((await w.names(w.asha, Role.SALESPERSON, q)).names, ["Priya Shah"], q);
      }
      for (const q of ["Priya", "shah", "priya shah", "SHAH PRIYA", "Pri Sha"]) {
        assert.deepEqual((await w.names(w.asha, Role.SALESPERSON, q)).names, ["Priya Shah"], q);
      }
      assert.deepEqual((await w.names(w.asha, Role.SALESPERSON, "Priya Mehta")).names, [], "words from two different customers do not match");
      assert.deepEqual((await w.names(w.asha, Role.SALESPERSON, "9999999999")).names, []);
    });
  });

  it("pagination: totals and pages agree across a search that spans several pages, with no repeats or gaps", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      for (let i = 0; i < 7; i++) await w.customer(`Kiran${i}`, "Patel", `9000000${String(i).padStart(3, "0")}`, w.asha.id);
      await w.customer("Other", "Person", "9111111111", w.asha.id);
      const seen: string[] = [];
      let total = 0;
      for (const page of [1, 2, 3, 4]) {
        const r = await w.names(w.asha, Role.SALESPERSON, "Patel", page, 3);
        total = r.total;
        seen.push(...r.names);
      }
      assert.equal(total, 7);
      assert.equal(seen.length, 7);
      assert.equal(new Set(seen).size, 7);
      assert.deepEqual((await w.names(w.asha, Role.SALESPERSON, "90000", 2, 3)).total, 7, "a partial phone search also reports the full authorised total");
    });
  });

  it("a telecaller finds their own customers and NOT another telecaller's or unassigned ones - the search never widens scope", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.customer("Meera", "Rao", "9000011111", w.asha.id);
      await w.customer("Meera", "Rao", "9000022222", w.bala.id);
      await w.customer("Meera", "Rao", "9000033333", null);
      assert.deepEqual((await w.names(w.asha, Role.SALESPERSON, "Meera")).total, 1);
      assert.deepEqual((await w.names(w.asha, Role.SALESPERSON, "9000022222")).names, [], "another telecaller's customer is invisible even by exact phone");
      assert.deepEqual((await w.names(w.asha, Role.SALESPERSON, "9000033333")).names, [], "an unassigned customer is invisible to a telecaller");
      assert.deepEqual((await w.names(w.bala, Role.SALESPERSON, "9000022222")).names, ["Meera Rao"]);
    });
  });

  it("an admin finds every customer by name or phone; a manager only their team's", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.customer("Meera", "Rao", "9000011111", w.asha.id); // asha is in the manager's group
      await w.customer("Meera", "Rao", "9000022222", w.bala.id); // bala is not
      await w.customer("Meera", "Rao", "9000033333", null);
      const adminHits = (await w.names(w.admin, Role.ADMIN, "Meera Rao")).names.length;
      assert.ok(adminHits >= 3, "admin sees the three of this world (and possibly others in the database)");
      for (const phone of ["9000011111", "9000022222", "9000033333"]) assert.equal((await w.names(w.admin, Role.ADMIN, phone)).names.length, 1, phone);
      assert.equal((await w.names(w.manager, Role.MANAGER, "9000011111")).names.length, 1, "the manager's own team member's customer");
      assert.equal((await w.names(w.manager, Role.MANAGER, "9000022222")).names.length, 0, "outside the manager's team");
      assert.equal((await w.names(w.manager, Role.MANAGER, "9000033333")).names.length, 0);
    });
  });
});
