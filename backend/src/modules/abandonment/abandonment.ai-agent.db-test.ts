// AI Agent tag and filters on the Abandoned Leads list, against the real schema (isolated database only: run-iso.ps1). Each test runs in ONE transaction that is always rolled back.
// Reproduces the production situation: lead-stage records that have abandoned carts AND AI Agent activity (the agency's "already ordered" calls), which the Leads page hides by design.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AbandonmentType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import AbandonmentService from "./abandonment.service.js";
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

async function world(tx: Prisma.TransactionClient) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const manager = await tx.user.create({ data: { name: "Team Lead", username: `m-${uid()}`, role: Role.MANAGER } });
  const tele = await tx.user.create({ data: { name: "Tele", username: `t-${uid()}`, role: Role.SALESPERSON } });
  const tag = uid().slice(0, 8);
  let n = 0;
  /** A lead-stage record with an abandoned cart; optionally with an AI Agent activity of the given intent / method. */
  const cart = async (o: { first: string; ai?: { intent: "ALREADY_ORDERED" | "INTERESTED"; method?: "COD" | "PREPAID" | null; result?: string }; ownerId?: string | null; status?: "NEW" | "RINGING" }) => {
    n += 1;
    const mobile = `+91900${String(n).padStart(7, "0")}`;
    const lead = await tx.lead.create({ data: { leadNumber: `L-${tag}-${n}`, firstName: o.first, mobile, normalizedMobile: mobile, assignedManagerId: manager.id, ownerId: o.ownerId ?? null, workingStatus: o.status ?? "NEW" }, select: { id: true } });
    await tx.abandonment.create({ data: { leadId: lead.id, type: AbandonmentType.CHECKOUT, detectedAt: new Date(), cartSnapshot: { currency: "INR", itemCount: 1, itemNames: ["X"] } as Prisma.InputJsonValue } });
    if (o.ai) {
      const requestId = uid();
      await tx.activity.create({
        data: {
          leadId: lead.id, type: "AI_AGENT_PAYMENT_LINK_REQUEST", source: "AI_AGENT", referenceType: "AgencyMessageRequest", referenceId: requestId, title: `AI Agent: ${o.ai.intent}`, description: `${o.first} - ${o.ai.intent}`,
          metadata: { aiAgent: true, intent: o.ai.intent, method: o.ai.method ?? null, requestId, normalizedMobile: mobile, result: o.ai.result ?? "NO_ELIGIBLE_ORDER", callOutcome: null },
        },
      });
    }
    return lead.id;
  };
  const svc = new AbandonmentService(tx as never, { bulkAssignManagers: async () => ({ assignedCount: 0 }), bulkAssignSalespersons: async () => ({ assignedCount: 0 }), bulkAssignSalespersonsByStaff: async () => ({ assignedCount: 0 }), bulkUpdateStatus: async () => ({ updatedCount: 0 }) } as never, null);
  const as = (u: { id: string; username: string; role: Role }) => ({ id: u.id, username: u.username, role: u.role });
  const mine = async (user: { id: string; username: string; role: Role }, q: Record<string, string> = {}) => {
    const parsed = validateListAbandonmentsQuery({ dateRange: "all", pageSize: "100", ...q });
    assert.ifError(parsed.error);
    return (await svc.listAbandonments(as(user), parsed.value!)).items.filter((i) => i.lead.leadNumber.includes(tag));
  };
  return { admin, manager, tele, cart, mine, tag, tx };
}

describe("Abandoned Leads: AI Agent tag and filters", () => {
  it("22 agency records (8 PREPAID + 14 COD) with abandoned carts are all found, tagged, and the filters split them correctly", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) ids.push(await w.cart({ first: `Pre${i}`, ai: { intent: "ALREADY_ORDERED", method: "PREPAID", result: "PREPAID_RECORDED" } }));
      for (let i = 0; i < 14; i++) ids.push(await w.cart({ first: `Cod${i}`, ai: { intent: "ALREADY_ORDERED", method: "COD" } }));
      const plain = await w.cart({ first: "Plain" });
      const interested = await w.cart({ first: "Keen", ai: { intent: "INTERESTED" } });

      const all = await w.mine(w.admin);
      assert.equal(all.length, 24, "no filter: every abandoned lead, unchanged");
      const only = await w.mine(w.admin, { aiAgent: "ONLY" });
      assert.equal(only.length, 23);
      assert.deepEqual(new Set(ids.filter((id) => only.some((i) => i.lead.id === id))), new Set(ids), "all 22 agency records are found");
      assert.deepEqual((await w.mine(w.admin, { aiAgent: "EXCLUDE" })).map((i) => i.lead.id), [plain]);
      assert.equal((await w.mine(w.admin, { aiAgentIntent: "ALREADY_ORDERED" })).length, 22);
      assert.deepEqual((await w.mine(w.admin, { aiAgentIntent: "INTERESTED" })).map((i) => i.lead.id), [interested]);
      assert.equal((await w.mine(w.admin, { aiAgent: "EXCLUDE", aiAgentIntent: "INTERESTED" })).length, 0, "contradictory filters combine, they do not widen");

      // labels: intent, method, interested
      const byName = new Map(all.map((i) => [i.lead.firstName, i.lead.aiAgent]));
      assert.deepEqual([byName.get("Pre0")?.lastIntent, byName.get("Pre0")?.lastMethod, byName.get("Pre0")?.interested], ["ALREADY_ORDERED", "PREPAID", false]);
      assert.deepEqual([byName.get("Cod0")?.lastIntent, byName.get("Cod0")?.lastMethod], ["ALREADY_ORDERED", "COD"]);
      assert.deepEqual([byName.get("Keen")?.lastIntent, byName.get("Keen")?.lastMethod, byName.get("Keen")?.interested], ["INTERESTED", null, true]);
      assert.equal(byName.get("Plain"), null);

    });
  });

  it("the AI Agent filters combine with search, lead status and assignment filters", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart({ first: "Anil", ai: { intent: "ALREADY_ORDERED", method: "COD" }, status: "RINGING", ownerId: w.tele.id });
      await w.cart({ first: "Anil2", ai: { intent: "ALREADY_ORDERED", method: "PREPAID" }, status: "NEW" });
      await w.cart({ first: "Anil3", status: "RINGING", ownerId: w.tele.id });
      const ids = async (q: Record<string, string>) => (await w.mine(w.admin, q)).map((i) => i.lead.id);
      assert.deepEqual(await ids({ aiAgent: "ONLY", workingStatus: "RINGING" }), [a]);
      assert.deepEqual(await ids({ aiAgent: "ONLY", search: "Anil", assignment: "ASSIGNED_TO_SALESPERSON" }), [a]);
      assert.equal((await ids({ aiAgent: "EXCLUDE", workingStatus: "RINGING" })).length, 1);
      assert.equal((await ids({ aiAgentIntent: "ALREADY_ORDERED", search: "Anil2" })).length, 1);
      assert.equal((await ids({ aiAgent: "ONLY", search: "NoSuchName" })).length, 0);
    });
  });

  it("permissions are unchanged: a telecaller sees only their own abandoned leads, AI-tagged or not", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const mineLead = await w.cart({ first: "Mine", ai: { intent: "ALREADY_ORDERED", method: "COD" }, ownerId: w.tele.id });
      const theirs = await w.cart({ first: "Theirs", ai: { intent: "ALREADY_ORDERED", method: "COD" } });
      const seen = (await w.mine(w.tele, { aiAgent: "ONLY" })).map((i) => i.lead.id);
      assert.deepEqual(seen, [mineLead]);
      assert.equal(seen.includes(theirs), false);
      assert.ok((await w.mine(w.admin, { aiAgent: "ONLY" })).some((i) => i.lead.id === theirs));
    });
  });

  it("the AI Agent activity timeline stays reachable: the activity rows are intact and linked to the lead; invalid filter values are refused", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const id = await w.cart({ first: "Tl", ai: { intent: "ALREADY_ORDERED", method: "PREPAID", result: "PREPAID_RECORDED" } });
      assert.equal(await tx.activity.count({ where: { leadId: id, source: "AI_AGENT" } }), 1);
      assert.ok(validateListAbandonmentsQuery({ aiAgent: "MAYBE" }).error);
      assert.ok(validateListAbandonmentsQuery({ aiAgentIntent: "BUYING" }).error);
      assert.ifError(validateListAbandonmentsQuery({ aiAgent: "ONLY", aiAgentIntent: "INTERESTED" }).error);
    });
  });
});
