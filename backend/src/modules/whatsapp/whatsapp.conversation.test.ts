import "dotenv/config";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@/utils/apiError.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import WhatsAppConversationService from "./whatsapp.conversation.service.js";

const ADMIN: AuthUser = { id: "admin-1", role: Role.ADMIN, email: "admin@example.com" };
const SALES_A: AuthUser = { id: "sales-a", role: Role.SALESPERSON, email: "a@example.com" };
const SALES_B: AuthUser = { id: "sales-b", role: Role.SALESPERSON, email: "b@example.com" };

function fakeDb(overrides: { leads?: any[] } = {}) {
  const conversations: any[] = [];
  const leads: any[] = overrides.leads ?? [{ id: "lead-1", ownerId: "sales-a" }];
  const messages: any[] = [];
  const activities: any[] = [];
  const users: any[] = [
    { id: "sales-a", name: "Sales A" },
    { id: "sales-b", name: "Sales B" },
  ];

  const db = {
    whatsAppConversation: {
      async findUnique({ where, select }: any) {
        const row = conversations.find((c) => c.leadId === where.leadId);
        return row ? project(row, select, users) : null;
      },
      async create({ data, select }: any) {
        const row = { id: `conv-${conversations.length + 1}`, mode: "HUMAN", assignedToId: null, lastReadAt: null, orderState: "DISCOVERY", orderDraft: null, aiSuggestedReply: null, lastAiHandoffReason: null, createdOrderId: null, ...data };
        conversations.push(row);
        return project(row, select, users);
      },
      async update({ where, data, select }: any) {
        const row = conversations.find((c) => c.leadId === where.leadId);
        Object.assign(row, data);
        return select ? project(row, select, users) : row;
      },
    },
    lead: {
      async findFirst({ where }: any) {
        const id = where.AND ? where.AND[0].id : where.id;
        const scope = where.AND?.[1];
        const lead = leads.find((l) => l.id === id);
        if (!lead) return null;
        if (scope?.ownerId && lead.ownerId !== scope.ownerId) return null;
        return lead;
      },
    },
    user: {
      async findUnique({ where }: any) {
        return users.find((u) => u.id === where.id) ?? null;
      },
    },
    whatsAppMessage: {
      async count({ where }: any) {
        return messages.filter((m) => m.leadId === where.leadId && m.direction === "INBOUND" && m.createdAt > where.createdAt.gt).length;
      },
    },
    activity: {
      async create({ data }: any) {
        activities.push(data);
        return data;
      },
    },
  } as unknown as DbClient;

  function project(row: any, select: any, users: any[]) {
    if (!select) return row;
    const out: any = {};
    for (const key of Object.keys(select)) {
      if (key === "assignedTo") {
        out.assignedTo = row.assignedToId ? { id: row.assignedToId, name: users.find((u) => u.id === row.assignedToId)?.name } : null;
      } else {
        out[key] = row[key];
      }
    }
    return out;
  }

  return { db, conversations, messages, activities };
}

describe("WhatsAppConversationService.getOrCreateConversation", () => {
  it("creates a conversation (mode HUMAN by default) on the first call for a lead", async () => {
    const { db, conversations } = fakeDb();
    const service = new WhatsAppConversationService(db);
    const conv = await service.getOrCreateConversation("lead-1", "AISENSY");
    assert.equal(conv.mode, "HUMAN");
    assert.equal(conv.provider, "AISENSY");
    assert.equal(conversations.length, 1);
  });

  it("reuses the same conversation row on a later message - never a second row for the same lead", async () => {
    const { db, conversations } = fakeDb();
    const service = new WhatsAppConversationService(db);
    const first = await service.getOrCreateConversation("lead-1", "AISENSY");
    const second = await service.getOrCreateConversation("lead-1", "AISENSY");
    assert.equal(first.id, second.id);
    assert.equal(conversations.length, 1);
  });

  it("updates the provider when a later message arrives on a different provider, without creating a new row", async () => {
    const { db, conversations } = fakeDb();
    const service = new WhatsAppConversationService(db);
    await service.getOrCreateConversation("lead-1", "AISENSY");
    const updated = await service.getOrCreateConversation("lead-1", "META");
    assert.equal(updated.provider, "META");
    assert.equal(conversations.length, 1);
  });
});

describe("WhatsAppConversationService RBAC", () => {
  it("lets the owning salesperson and an admin access the conversation; blocks a different salesperson", async () => {
    const { db } = fakeDb();
    const service = new WhatsAppConversationService(db);
    await service.getOrCreateConversation("lead-1", "AISENSY");

    await assert.doesNotReject(() => service.getConversationDetail(ADMIN, "lead-1"));
    await assert.doesNotReject(() => service.getConversationDetail(SALES_A, "lead-1"));
    await assert.rejects(() => service.getConversationDetail(SALES_B, "lead-1"), (err: unknown) => err instanceof ApiError && err.statusCode === 404);
  });

  it("lets a conversation's assignee access it even if they don't own the lead", async () => {
    const { db } = fakeDb();
    const service = new WhatsAppConversationService(db);
    await service.getOrCreateConversation("lead-1", "AISENSY");
    await service.assignConversation(ADMIN, "lead-1", { userId: "sales-b" });
    await assert.doesNotReject(() => service.getConversationDetail(SALES_B, "lead-1"));
  });
});

describe("WhatsAppConversationService assignment and mode", () => {
  it("a salesperson can claim an unassigned conversation for themselves, but not reassign an already-assigned one, and not assign it to someone else", async () => {
    const { db, activities } = fakeDb();
    const service = new WhatsAppConversationService(db);
    await service.getOrCreateConversation("lead-1", "AISENSY");

    await assert.rejects(() => service.assignConversation(SALES_A, "lead-1", { userId: "sales-b" }), ApiError);
    const result = await service.assignConversation(SALES_A, "lead-1", { userId: "sales-a" });
    assert.equal(result.assignedTo?.id, "sales-a");
    assert.equal(activities.at(-1).type, "CONVERSATION_ASSIGNED");

    await assert.rejects(() => service.assignConversation(SALES_A, "lead-1", { userId: "sales-a" }), ApiError);
  });

  it("refuses to enable AI mode on an unassigned conversation", async () => {
    const { db } = fakeDb();
    const service = new WhatsAppConversationService(db);
    await service.getOrCreateConversation("lead-1", "AISENSY");
    await assert.rejects(() => service.returnToAi(ADMIN, "lead-1"), (err: unknown) => err instanceof ApiError && err.statusCode === 400);
  });

  it("moves AI -> HUMAN and back, auditing both directions", async () => {
    const { db, activities } = fakeDb();
    const service = new WhatsAppConversationService(db);
    await service.getOrCreateConversation("lead-1", "AISENSY");
    await service.assignConversation(ADMIN, "lead-1", { userId: "sales-a" });

    const toAi = await service.returnToAi(ADMIN, "lead-1");
    assert.equal(toAi.mode, "AI");
    assert.equal(activities.at(-1).type, "CONVERSATION_HUMAN_HANDBACK");

    const toHuman = await service.handoffToHuman(ADMIN, "lead-1");
    assert.equal(toHuman.mode, "HUMAN");
    assert.equal(activities.at(-1).type, "CONVERSATION_AI_HANDOFF");
  });

  it("setModeInternal (AI-triggered handoff) records the reason and a SYSTEM-sourced activity, with no RBAC check", async () => {
    const { db, activities } = fakeDb();
    const service = new WhatsAppConversationService(db);
    await service.getOrCreateConversation("lead-1", "AISENSY");
    await service.setModeInternal("lead-1", "HUMAN", "Low confidence");
    const detail = await service.getConversationDetail(ADMIN, "lead-1");
    assert.equal(detail.mode, "HUMAN");
    assert.equal(detail.lastAiHandoffReason, "Low confidence");
    assert.equal(activities.at(-1).source, "SYSTEM");
  });
});

describe("WhatsAppConversationService.markRead / unread count", () => {
  it("marking read updates lastReadAt so unreadCount drops to zero for messages received before it", async () => {
    const { db, messages } = fakeDb();
    const service = new WhatsAppConversationService(db);
    await service.getOrCreateConversation("lead-1", "AISENSY");
    messages.push({ leadId: "lead-1", direction: "INBOUND", createdAt: new Date("2026-01-01") });

    const before = await service.getConversationDetail(ADMIN, "lead-1");
    assert.equal(before.unreadCount, 1);

    await service.markRead(ADMIN, "lead-1");
    const after = await service.getConversationDetail(ADMIN, "lead-1");
    assert.equal(after.unreadCount, 0);
  });
});
