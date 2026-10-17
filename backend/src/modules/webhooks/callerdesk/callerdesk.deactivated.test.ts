import assert from "node:assert/strict";
import { describe, it } from "node:test";
import LeadService from "../../lead/lead.service.js";
import { createPrismaCallEventStore } from "./callerdesk.store.js";

// An in-memory stand-in for the Prisma calls the real CallerDesk store and LeadService make. It applies the
// `where` those calls really build (mobile candidates, source, workingStatus), so a guard that is missing
// or wrong shows up as a deactivated lead being selected/updated.
interface Row { id: string; normalizedMobile: string; sourceId: string | null; workingStatus: string; firstName: string; createdAt: number; ownerId: string | null }

function statusAllowed(row: Row, filter: unknown): boolean {
  const f = filter as { not?: string } | undefined;
  return f?.not === undefined || row.workingStatus !== f.not;
}

function makeDb(leads: Row[]) {
  const updates: string[] = [];
  const created: Row[] = [];
  const db = {
    lead: {
      async findMany({ where, orderBy, take }: any) {
        let rows = leads.filter((l) => where.normalizedMobile.in.includes(l.normalizedMobile) && statusAllowed(l, where.workingStatus));
        if (orderBy?.createdAt === "asc") rows = [...rows].sort((a, b) => a.createdAt - b.createdAt);
        return rows.slice(0, take ?? rows.length).map((l) => ({ id: l.id, ownerId: l.ownerId }));
      },
      async findFirst({ where }: any) {
        const mobiles = (where.OR as { normalizedMobile?: string }[]).map((c) => c.normalizedMobile);
        return leads.find((l) => l.sourceId === where.sourceId && mobiles.includes(l.normalizedMobile) && statusAllowed(l, where.workingStatus)) ?? null;
      },
      async update({ where }: any) {
        updates.push(where.id);
        return leads.find((l) => l.id === where.id);
      },
      async create({ data }: any) {
        const row: Row = { id: `new-${created.length + 1}`, normalizedMobile: data.normalizedMobile, sourceId: data.sourceId, workingStatus: "NEW", firstName: data.firstName, createdAt: 99, ownerId: null };
        created.push(row);
        leads.push(row);
        return row;
      },
    },
    source: { async upsert() { return { id: "ivr-source" }; } },
    activity: { async create() { return {}; } },
  };
  return { db, updates, created };
}

const storeFor = (db: unknown) => createPrismaCallEventStore({ $transaction: (fn: (tx: unknown) => unknown) => fn(db) } as never);
const TEST_LEAD: Row = { id: "TEST", normalizedMobile: "+919000000011", sourceId: "ivr-source", workingStatus: "DEACTIVATED", firstName: "Test", createdAt: 1, ownerId: "o1" };
const ACTIVE_LEAD: Row = { id: "ACTIVE", normalizedMobile: "+919000000011", sourceId: null, workingStatus: "NEW", firstName: "Real", createdAt: 50, ownerId: "o2" };
const CANDIDATES = ["+919000000011", "919000000011", "9000000011", "09000000011"];

describe("inbound IVR lead matching skips deactivated leads", () => {
  it("never matches a deactivated lead - a caller whose only lead is deactivated is treated as having none", async () => {
    const { db } = makeDb([{ ...TEST_LEAD }]);
    const found = await storeFor(db).transaction((tx) => tx.findLeadsByNormalizedMobile(CANDIDATES));
    assert.deepEqual(found, []);
  });

  it("prefers the active lead over an older deactivated one", async () => {
    const { db } = makeDb([{ ...TEST_LEAD }, { ...ACTIVE_LEAD }]);
    const found = await storeFor(db).transaction((tx) => tx.findLeadsByNormalizedMobile(CANDIDATES));
    assert.deepEqual(found.map((l) => l.id), ["ACTIVE"]);
  });

  it("still matches active leads in any other status, oldest first", async () => {
    const { db } = makeDb([{ ...ACTIVE_LEAD, id: "B", createdAt: 30, workingStatus: "INTERESTED" }, { ...ACTIVE_LEAD, id: "A", createdAt: 10, workingStatus: "CONVERTED" }]);
    const found = await storeFor(db).transaction((tx) => tx.findLeadsByNormalizedMobile(CANDIDATES));
    assert.deepEqual(found.map((l) => l.id), ["A"]);
  });

  it("falls through to the existing create-an-IVR-Lead path, and never updates the deactivated lead even if it came from the IVR source", async () => {
    const { db, updates, created } = makeDb([{ ...TEST_LEAD }]);
    const lead = await storeFor(db).transaction(async (tx) => {
      assert.deepEqual(await tx.findLeadsByNormalizedMobile(CANDIDATES), []);
      return tx.createIvrLead("09000000011");
    });
    assert.equal(created.length, 1, "the existing workflow creates a fresh Lead for an unmatched caller");
    assert.notEqual(lead?.id, "TEST");
    assert.deepEqual(updates, [], "the deactivated lead was not touched");
  });
});

describe("LeadService.createLeadFromSource deactivated-lead guard is opt-in", () => {
  const data = { firstName: "Caller", mobile: "09000000011" };

  it("with excludeDeactivated, a deactivated same-source lead is not reused or updated", async () => {
    const { db, updates, created } = makeDb([{ ...TEST_LEAD }]);
    const lead = await new LeadService().createLeadFromSource("ivr-source", data, "Lead created via test", db as never, { excludeDeactivated: true });
    assert.equal(created.length, 1);
    assert.notEqual(lead.id, "TEST");
    assert.deepEqual(updates, []);
  });

  it("with excludeDeactivated, an active same-source lead is still reused (no duplicate)", async () => {
    const { db, updates, created } = makeDb([{ ...TEST_LEAD, id: "LIVE", workingStatus: "NEW" }]);
    const lead = await new LeadService().createLeadFromSource("ivr-source", data, "Lead created via test", db as never, { excludeDeactivated: true });
    assert.equal(lead.id, "LIVE");
    assert.equal(created.length, 0);
    assert.deepEqual(updates, ["LIVE"]);
  });

  it("without the option, behaviour is unchanged for every other caller (Shopify / WhatsApp / Meta)", async () => {
    const { db, updates, created } = makeDb([{ ...TEST_LEAD }]);
    const lead = await new LeadService().createLeadFromSource("ivr-source", data, "Lead created via test", db as never);
    assert.equal(lead.id, "TEST");
    assert.equal(created.length, 0);
    assert.deepEqual(updates, ["TEST"]);
  });
});
