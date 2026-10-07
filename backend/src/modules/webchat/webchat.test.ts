import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConversationMode, Role, WebChatSender } from "../../../generated/prisma/enums.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { buildWebChatListWhere, scopedWebChatWhere, webChatSearchWhere } from "./webchat.filters.js";
import { buildWebChatScope, canAssignConversationTo } from "./webchat.scope.js";
import { WebChatService } from "./webchat.service.js";
import { validateAssignBody, validateListWebChatQuery, validateSendMessageBody } from "./webchat.validators.js";

const admin: AuthUser = { id: "admin-1", role: Role.ADMIN, username: "a" };
const manager: AuthUser = { id: "mgr-1", role: Role.MANAGER, username: "m" };
const salesperson: AuthUser = { id: "sp-1", role: Role.SALESPERSON, username: "sp1" };

const UUID_A = "0b8f4c1e-6a52-4c53-9d0a-3f1b2c4d5e6f";
const UUID_B = "1c9f4c1e-6a52-4c53-9d0a-3f1b2c4d5e6f";

/** Minimal in-memory stand-in for the Prisma calls WebChatService makes. Scope is enforced by the
 * real buildWebChatScope/scopedWebChatWhere in production; here findFirst honours the id part only,
 * and the scope rules themselves are covered by the direct scope tests below. */
function fakeDb(seed: { conversations: any[]; users?: any[]; groups?: any[] }) {
  const conversations = seed.conversations;
  const messages: any[] = [];
  const activities: any[] = [];
  const users = seed.users ?? [];
  const groups = seed.groups ?? [];

  const db: any = {
    webChatConversation: {
      async findFirst({ where }: any) {
        const id = where.id ?? where.AND?.[0]?.id;
        return conversations.find((c) => c.id === id) ?? null;
      },
      async update({ where, data }: any) {
        const row = conversations.find((c) => c.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return { id: row.id };
      },
      async count() {
        return conversations.length;
      },
      async findMany() {
        return conversations;
      },
    },
    webChatMessage: {
      async create({ data }: any) {
        const row = { id: `m-${messages.length + 1}`, createdAt: new Date("2026-10-05T12:00:00.000Z"), ...data };
        messages.push(row);
        return row;
      },
      async findMany({ where }: any) {
        return messages.filter((m) => m.conversationId === where.conversationId);
      },
    },
    user: {
      async findFirst({ where }: any) {
        return users.find((u) => u.id === where.id && (where.role?.in ? where.role.in.includes(u.role) : true)) ?? null;
      },
    },
    group: {
      async findMany({ where }: any) {
        return groups.filter((g) => g.managerId === where.managerId);
      },
    },
    activity: {
      async create({ data }: any) {
        activities.push(data);
        return data;
      },
    },
  };

  return { db, messages, activities, conversations };
}

describe("buildWebChatScope - who may see which conversations", () => {
  it("ADMIN sees everything (no restriction)", async () => {
    const scope = await buildWebChatScope(admin, fakeDb({ conversations: [] }).db);
    assert.deepEqual(scope, {});
  });

  it("SALESPERSON sees only their own, the unassigned queue, or leads they own - never a colleague's", async () => {
    const scope = await buildWebChatScope(salesperson, fakeDb({ conversations: [] }).db);
    assert.deepEqual(scope, {
      OR: [{ assignedToId: "sp-1" }, { assignedToId: null }, { lead: { ownerId: "sp-1" } }],
    });
  });

  it("MANAGER follows team scope: own + team assigned, unassigned queue, or team-owned leads", async () => {
    const db = fakeDb({
      conversations: [],
      groups: [{ managerId: "mgr-1", id: "g1", members: [{ isActive: true, user: { id: "sp-2", name: "Ravi" } }] }],
    }).db;
    const scope = (await buildWebChatScope(manager, db)) as any;
    assert.deepEqual(scope.OR[0], { assignedToId: { in: ["mgr-1", "sp-2"] } });
    assert.deepEqual(scope.OR[1], { assignedToId: null });
    assert.deepEqual(scope.OR[2].lead.OR[0], { groupId: { in: ["g1"] } });
  });
});

describe("canAssignConversationTo - assignment authorization (test 12)", () => {
  it("a SALESPERSON may only claim a conversation for themselves", async () => {
    const db = fakeDb({ conversations: [] }).db;
    assert.equal(await canAssignConversationTo(salesperson, "sp-1", db), true);
    assert.equal(await canAssignConversationTo(salesperson, "sp-2", db), false);
  });

  it("a MANAGER may assign to self or a current team member, never to someone outside the team", async () => {
    const db = fakeDb({
      conversations: [],
      groups: [{ managerId: "mgr-1", id: "g1", members: [{ isActive: true, user: { id: "sp-2", name: "Ravi" } }] }],
    }).db;
    assert.equal(await canAssignConversationTo(manager, "mgr-1", db), true);
    assert.equal(await canAssignConversationTo(manager, "sp-2", db), true);
    assert.equal(await canAssignConversationTo(manager, "outsider", db), false);
  });

  it("an ADMIN may assign to any target (the target itself is still validated as an active agent)", async () => {
    assert.equal(await canAssignConversationTo(admin, "anyone", fakeDb({ conversations: [] }).db), true);
  });
});

describe("salesperson access to someone else's conversation (test 13)", () => {
  it("an out-of-scope id is treated exactly like a missing one", async () => {
    const restrictedScope = { OR: [{ assignedToId: "sp-1" }, { assignedToId: null }] };
    assert.deepEqual(scopedWebChatWhere(UUID_A, restrictedScope), { AND: [{ id: UUID_A }, restrictedScope] });
  });

  it("the service refuses to read a conversation outside scope with a 404, not 403 (no existence leak)", async () => {
    const service = new WebChatService(fakeDb({ conversations: [] }).db);
    await assert.rejects(service.getConversation(salesperson, UUID_A), (err: any) => err.statusCode === 404);
  });
});

describe("read / archive / handoff / ai-mode / agent message (tests 10, 11, 14, 15, 16)", () => {
  it("read updates lastReadAt (test 14)", async () => {
    const conv = { id: UUID_A, lastReadAt: null, assignedToId: null, leadId: null };
    const { db } = fakeDb({ conversations: [conv] });
    const service = new WebChatService(db);
    const result = await service.markRead(admin, UUID_A);
    assert.ok(result.lastReadAt instanceof Date);
    assert.equal(conv.lastReadAt, result.lastReadAt);
  });

  it("handoff changes mode AI -> HUMAN (test 10)", async () => {
    const conv = { id: UUID_A, mode: ConversationMode.AI, leadId: null };
    const service = new WebChatService(fakeDb({ conversations: [conv] }).db);
    const result = await service.handoff(admin, UUID_A);
    assert.equal(result.mode, ConversationMode.HUMAN);
    assert.equal(conv.mode, ConversationMode.HUMAN);
  });

  it("ai-mode changes mode HUMAN -> AI (test 11)", async () => {
    const conv = { id: UUID_A, mode: ConversationMode.HUMAN, leadId: null };
    const service = new WebChatService(fakeDb({ conversations: [conv] }).db);
    const result = await service.returnToAi(admin, UUID_A);
    assert.equal(result.mode, ConversationMode.AI);
    assert.equal(conv.mode, ConversationMode.AI);
  });

  it("archive sets archivedAt and deletes nothing (test 15)", async () => {
    const conv = { id: UUID_A, archivedAt: null, leadId: null };
    const { db, messages } = fakeDb({ conversations: [conv] });
    const service = new WebChatService(db);
    const result = await service.archive(admin, UUID_A);
    assert.ok(result.archivedAt instanceof Date);
    assert.equal(conv.archivedAt, result.archivedAt);
    assert.equal(messages.length, 0, "archiving never touches messages");
  });

  it("an agent reply is stored as sender AGENT with the authenticated user as sentById (test 16)", async () => {
    const conv = { id: UUID_A, leadId: null };
    const { db, messages } = fakeDb({ conversations: [conv] });
    const service = new WebChatService(db);
    await service.sendAgentMessage(salesperson, UUID_A, "Hello, how can I help?");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].sender, WebChatSender.AGENT);
    assert.equal(messages[0].sentById, "sp-1");
    assert.equal(messages[0].body, "Hello, how can I help?");
  });

  it("assignment to an inactive/non-agent user is rejected", async () => {
    const conv = { id: UUID_A, leadId: null, assignedToId: null };
    const service = new WebChatService(fakeDb({ conversations: [conv], users: [] }).db);
    await assert.rejects(service.assign(admin, UUID_A, "ghost"), (err: any) => err.statusCode === 400);
  });

  it("assignment with a Lead records an ASSIGNMENT activity; without a Lead it records nothing", async () => {
    const withLead = { id: UUID_A, leadId: "lead-1", assignedToId: null };
    const withoutLead = { id: UUID_B, leadId: null, assignedToId: null };
    const users = [{ id: "sp-1", name: "Asha", role: Role.SALESPERSON, status: "ACTIVE" }];

    const fake = fakeDb({ conversations: [withLead, withoutLead], users });
    const service = new WebChatService(fake.db);
    await service.assign(salesperson, UUID_A, "sp-1");
    await service.assign(salesperson, UUID_B, "sp-1");

    assert.equal(fake.activities.length, 1);
    assert.equal(fake.activities[0].leadId, "lead-1");
    assert.equal(fake.activities[0].type, "ASSIGNMENT");
  });
});

describe("list query: pagination, search, archived, mode, assigned (tests 17, 18, 19)", () => {
  it("defaults to page 1, limit 20, and the active (non-archived) queue", () => {
    const { error, value } = validateListWebChatQuery({});
    assert.equal(error, null);
    assert.deepEqual(value, { page: 1, limit: 20 });
    const where = buildWebChatListWhere(value, {});
    assert.deepEqual(where, { AND: [{ archivedAt: null }] });
  });

  it("pagination limit is bounded to 1..100", () => {
    assert.ok(validateListWebChatQuery({ limit: "0" }).error);
    assert.ok(validateListWebChatQuery({ limit: "101" }).error);
    assert.equal(validateListWebChatQuery({ limit: "100" }).error, null);
  });

  it("search matches the chatbot conversation id or the linked lead's name/number/mobile, every term ANDed", () => {
    const where = webChatSearchWhere("Priya 9876");
    assert.equal((where.AND as unknown[]).length, 2);
    const first = (where.AND as any[])[0];
    assert.ok(first.OR.some((c: any) => c.externalConversationId?.contains === "Priya"));
  });

  it("archived=true shows only archived conversations; default hides them", () => {
    const archived = buildWebChatListWhere({ archived: true }, {});
    assert.deepEqual(archived, { AND: [{ archivedAt: { not: null } }] });
  });

  it("mode and assigned filters are additive clauses, never replacing the scope", () => {
    const scope = { OR: [{ assignedToId: "sp-1" }, { assignedToId: null }] };
    const where = buildWebChatListWhere({ mode: ConversationMode.HUMAN, assigned: false }, scope) as any;
    assert.deepEqual(where.AND[0], scope);
    assert.ok(where.AND.some((c: any) => c.mode === ConversationMode.HUMAN));
    assert.ok(where.AND.some((c: any) => c.assignedToId === null));
  });

  it("body validators reject empty agent text and bad assignee ids", () => {
    assert.ok(validateSendMessageBody({ text: "   " }).error);
    assert.ok(validateAssignBody({ assignedToId: "not-a-uuid" }).error);
    assert.equal(validateAssignBody({ assignedToId: UUID_A }).error, null);
  });
});
