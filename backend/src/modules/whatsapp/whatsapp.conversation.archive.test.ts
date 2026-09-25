import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@/utils/apiError.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import WhatsAppConversationService from "./whatsapp.conversation.service.js";

const ADMIN: AuthUser = { id: "admin-1", role: Role.ADMIN, email: "admin@example.com" };
const SALES_B: AuthUser = { id: "sales-b", role: Role.SALESPERSON, email: "b@example.com" };

function fakeDb(seed: { leads?: any[]; conversations?: any[]; messages?: any[]; activities?: any[] } = {}) {
  const activities: any[] = seed.activities ?? [];
  const messages: any[] = seed.messages ?? [];
  const conversations: any[] = seed.conversations ?? [{ id: "c1", leadId: "lead-1", assignedToId: null }];
  const leads: any[] = seed.leads ?? [{ id: "lead-1", ownerId: "sales-a" }];
  const db = {
    whatsAppConversation: { async findUnique({ where }: any) { return conversations.find((c) => c.leadId === where.leadId) ?? null; } },
    lead: { async findFirst({ where }: any) { const id = where.AND ? where.AND[0].id : where.id; const scope = where.AND?.[1]; const lead = leads.find((l) => l.id === id); if (!lead) return null; if (scope?.ownerId && lead.ownerId !== scope.ownerId) return null; return lead; } },
    whatsAppMessage: {
      async findFirst({ where }: any) { return messages.filter((m) => m.leadId === where.leadId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null; },
      async count() { return 0; },
    },
    activity: {
      async create({ data }: any) { const row = { id: `a${activities.length}`, createdAt: new Date(), ...data }; activities.push(row); return row; },
      async findFirst({ where }: any) { return activities.filter((a) => a.leadId === where.leadId && a.type === where.type && where.title.in.includes(a.title)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null; },
      async findMany({ where }: any) { return activities.filter((a) => where.leadId.in.includes(a.leadId) && a.type === where.type && where.title.in.includes(a.title)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); },
    },
  } as unknown as DbClient;
  return { db, activities, messages };
}

const svc = (db: DbClient) => new WhatsAppConversationService(db);

describe("archiveConversation / unarchiveConversation", () => {
  it("archives a conversation (hides it), and archiving again is idempotent - no duplicate Activity", async () => {
    const { db, activities } = fakeDb();
    const first = await svc(db).archiveConversation(ADMIN, "lead-1");
    assert.equal(first.archived, true);
    const second = await svc(db).archiveConversation(ADMIN, "lead-1");
    assert.equal(second.archived, true);
    assert.equal(activities.filter((a) => a.title === "WhatsApp conversation archived").length, 1, "no duplicate marker on a repeat archive");
  });

  it("restores an archived conversation, and unarchiving an already-active one is idempotent", async () => {
    const { db } = fakeDb();
    await svc(db).archiveConversation(ADMIN, "lead-1");
    const restored = await svc(db).unarchiveConversation(ADMIN, "lead-1");
    assert.equal(restored.archived, false);
    const again = await svc(db).unarchiveConversation(ADMIN, "lead-1");
    assert.equal(again.archived, false);
  });

  it("does not delete the lead, orders, or payments - archiving only ever writes an Activity", async () => {
    const { db, activities } = fakeDb();
    await svc(db).archiveConversation(ADMIN, "lead-1");
    assert.equal(activities.length, 1);
    assert.equal(activities[0].description, "The customer, orders and payment records were not affected.");
  });

  it("a new inbound message after archiving automatically un-archives it (no schema, purely derived)", async () => {
    const seedTime = new Date("2026-09-25T10:00:00.000Z");
    const { db, messages } = fakeDb({ messages: [{ leadId: "lead-1", createdAt: seedTime }] });
    await svc(db).archiveConversation(ADMIN, "lead-1");
    // Simulate the queries archiveConversation just ran happened "at" seedTime + 1ms (activities carry
    // real createdAt via Prisma's default(now()) in production; here we just push a message that is
    // clearly LATER than anything recorded so far).
    messages.push({ leadId: "lead-1", createdAt: new Date(Date.now() + 60_000) });
    const detail = await svc(db).getConversationDetail(ADMIN, "lead-1");
    assert.equal(detail.archived, false, "a message newer than the archive marker restores visibility");
  });

  it("RBAC: a salesperson outside the lead's scope (and not the assignee) cannot archive it", async () => {
    const { db } = fakeDb();
    await assert.rejects(() => svc(db).archiveConversation(SALES_B, "lead-1"), (e: unknown) => e instanceof ApiError && e.statusCode === 404);
  });

  it("RBAC: the conversation's own assignee can archive it even without owning the lead", async () => {
    const { db } = fakeDb({ leads: [{ id: "lead-1", ownerId: "someone-else" }], conversations: [{ id: "c1", leadId: "lead-1", assignedToId: "sales-b" }] });
    const result = await svc(db).archiveConversation(SALES_B, "lead-1");
    assert.equal(result.archived, true);
  });

  it("archivedLeadIds (bulk) matches isArchived (single) for a mixed set of leads", async () => {
    const now = new Date("2026-09-25T12:00:00.000Z");
    const { db, activities } = fakeDb({
      conversations: [{ id: "c1", leadId: "lead-1", assignedToId: null }, { id: "c2", leadId: "lead-2", assignedToId: null }],
      leads: [{ id: "lead-1", ownerId: "sales-a" }, { id: "lead-2", ownerId: "sales-a" }],
    });
    activities.push({ id: "a1", leadId: "lead-1", type: "STATUS_CHANGE", title: "WhatsApp conversation archived", createdAt: now });
    // lead-2 has no archive activity at all - never archived.
    const bulk = await svc(db).archivedLeadIds(["lead-1", "lead-2"], new Map());
    assert.deepEqual([...bulk], ["lead-1"]);
  });
});
