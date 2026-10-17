import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { prisma } from "@/lib/prisma.js";
import type { AuthUser } from "@/middlewares/auth.js";
import LeadService from "./lead.service.js";

// listLeads builds one Prisma `where` and passes it to lead.findMany / lead.count. These tests stand in for
// the database with an in-memory table and apply the `workingStatus` part of that real `where`, so a lead
// the query would exclude is genuinely absent from the result.
type Row = { id: string; workingStatus: string };

const rows: Row[] = [
  { id: "active-new", workingStatus: "NEW" },
  { id: "active-interested", workingStatus: "INTERESTED" },
  { id: "test-lead-deactivated", workingStatus: "DEACTIVATED" },
];

function matchesStatus(row: Row, filter: unknown): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "string") return row.workingStatus === filter;
  const f = filter as { not?: string; in?: string[] };
  if (f.not !== undefined) return row.workingStatus !== f.not;
  if (f.in) return f.in.includes(row.workingStatus);
  return true;
}

let lastWhere: Record<string, unknown> | undefined;

// The Prisma client exposes models through accessors, so the stand-in replaces the whole `lead` delegate
// on the shared client for the duration of a test and restores it afterwards.
const original = Object.getOwnPropertyDescriptor(prisma, "lead");
function stubDatabase() {
  const fake = {
    async findMany(args: { where: Record<string, unknown> }) {
      lastWhere = args.where;
      return rows.filter((r) => matchesStatus(r, args.where.workingStatus)).map((r) => ({ ...r, calls: [], tasks: [] }));
    },
    async count(args: { where: Record<string, unknown> }) {
      return rows.filter((r) => matchesStatus(r, args.where.workingStatus)).length;
    },
  };
  Object.defineProperty(prisma, "lead", { value: fake, configurable: true, writable: true });
}
function restoreDatabase() {
  if (original) Object.defineProperty(prisma, "lead", original);
  else delete (prisma as unknown as Record<string, unknown>).lead;
}

const admin = { id: "admin-1", role: "ADMIN" } as unknown as AuthUser;
const salesperson = { id: "sales-1", role: "SALESPERSON" } as unknown as AuthUser;
const base = { page: 1, limit: 20 } as never;

describe("listLeads - deactivated leads", () => {
  afterEach(restoreDatabase);

  it("the default All Leads query (no status filter) does not return a deactivated lead", async () => {
    stubDatabase();
    const result = await new LeadService().listLeads(admin, base);
    const ids = result.data.map((l: { id: string }) => l.id);
    assert.deepEqual(ids, ["active-new", "active-interested"]);
    assert.equal(ids.includes("test-lead-deactivated"), false);
    assert.equal(result.pagination.total, 2, "the total (and so the page count) excludes it as well");
  });

  it("applies to every role's default list", async () => {
    stubDatabase();
    const result = await new LeadService().listLeads(salesperson, base);
    assert.equal(result.data.some((l: { id: string }) => l.id === "test-lead-deactivated"), false);
  });

  it("keeps the other filters when excluding deactivated leads", async () => {
    stubDatabase();
    await new LeadService().listLeads(admin, { ...(base as object), search: "asha", sourceId: "s1" } as never);
    assert.equal(lastWhere?.sourceId, "s1");
    assert.ok(Array.isArray(lastWhere?.OR), "search is still applied");
    assert.deepEqual(lastWhere?.workingStatus, { not: "DEACTIVATED" });
  });

  it("an explicitly chosen status filter behaves exactly as before", async () => {
    stubDatabase();
    const service = new LeadService();

    const interested = await service.listLeads(admin, { ...(base as object), workingStatus: "INTERESTED" } as never);
    assert.deepEqual(lastWhere?.workingStatus, "INTERESTED");
    assert.deepEqual(interested.data.map((l: { id: string }) => l.id), ["active-interested"]);

    await service.listLeads(salesperson, { ...(base as object), workingStatus: "NEW" } as never);
    assert.deepEqual(lastWhere?.workingStatus, { in: ["NEW", "ASSIGNED"] }, "the salesperson NEW-includes-ASSIGNED rule is unchanged");
  });
});
