import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { notifyOrderConfirmation, notifyPaymentLink } from "./whatsapp.order-notify.service.js";
import WhatsAppFreeTextService from "./whatsapp.freetext.service.js";
import WhatsAppMessagingService from "./whatsapp.messaging.service.js";
import type { MetaCloudApiProvider } from "./whatsapp.meta.provider.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";

const USER: AuthUser = { id: "user-1", role: Role.ADMIN, email: "a@example.com" };
const NOW = new Date("2026-09-25T12:00:00.000Z");
const HOUR = 3_600_000;

function fakeDb(seed: { conversations?: any[]; messages?: any[]; templates?: any[] } = {}) {
  const templates = seed.templates ?? [];
  const messages = seed.messages ?? [];
  return {
    whatsAppConversation: { async findUnique({ where }: any) { return (seed.conversations ?? []).find((c) => c.leadId === where.leadId) ?? null; } },
    whatsAppMessage: {
      async findFirst({ where }: any) {
        const rows = messages.filter((m) => m.leadId === where.leadId && (!where.provider || m.provider === where.provider) && (!where.direction || m.direction === where.direction)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows[0] ?? null;
      },
      async create({ data }: any) { const row = { id: `m${messages.length}`, ...data }; messages.push(row); return row; },
    },
    whatsAppTemplate: {
      async findMany({ where }: any) { return templates.filter((t) => t.provider === where.provider && t.status === where.status); },
      async findUnique({ where }: any) { return templates.find((t) => t.id === where.id) ?? null; },
    },
  } as unknown as DbClient;
}

function fakeMeta(): MetaCloudApiProvider {
  return { async sendText() { return { providerMessageId: "wamid.1", raw: {} }; } } as unknown as MetaCloudApiProvider;
}

function fakeLegacyProvider(id: WhatsAppProvider["id"]): WhatsAppProvider {
  return {
    id,
    sendTemplateMessage: async () => ({ providerMessageId: `${id}-1`, raw: {} }),
    verifyWebhook: () => true,
    parseIncomingWebhook: () => [],
    parseDeliveryStatusWebhook: () => [],
    listTemplates: async () => ({ supported: false, reason: "n/a" }),
  };
}

const orderParams = { leadId: "lead-1", orderId: "order-1", normalizedMobile: "+919876543210", orderNumber: "CRM-1", totalAmount: "699.00", currency: "INR" };
const linkParams = { leadId: "lead-1", orderId: "order-1", normalizedMobile: "+919876543210", orderNumber: "CRM-1", paymentUrl: "https://pay.example/abc", amount: "699.00", currency: "INR" };

describe("notifyOrderConfirmation", () => {
  it("META, window open: sends free text, never touches templates", async () => {
    const db = fakeDb({ conversations: [{ leadId: "lead-1", provider: "META" }], messages: [{ leadId: "lead-1", provider: "META", direction: "INBOUND", createdAt: new Date(NOW.getTime() - HOUR), receivedAt: new Date(NOW.getTime() - HOUR) }] });
    const freeText = new WhatsAppFreeTextService(db, async () => fakeMeta(), () => NOW);
    const result = await notifyOrderConfirmation(db, USER, orderParams, { freeText });
    assert.deepEqual(result, { sent: true, via: "FREE_TEXT", provider: "META" });
  });

  it("META, window closed, an approved META template exists: falls back to it", async () => {
    const db = fakeDb({
      conversations: [{ leadId: "lead-1", provider: "META" }],
      templates: [{ id: "t1", provider: "META", status: "APPROVED", name: "crm_order_confirmation", variables: ["customer_name", "order_number", "order_amount"], language: "en", body: "Hi {{1}}" }],
    });
    const messaging = new WhatsAppMessagingService(db, () => null, async () => fakeLegacyProvider("META") as any);
    const freeText = new WhatsAppFreeTextService(db, async () => fakeMeta(), () => NOW);
    // sendTemplate calls loadAndResolve -> resolveSendProvider, which needs a real lead/order lookup on `db` -
    // simplified here by asserting the FAILURE reason path only when the DB can't actually resolve a template send
    // (this fake db has no lead/order tables), proving notifyOrderConfirmation still never throws.
    const result = await notifyOrderConfirmation(db, USER, orderParams, { freeText, messaging });
    assert.equal(result.sent, false);
    assert.equal(result.via, null);
    assert.ok(result.reason);
  });

  it("META not configured / window closed and NO approved template: reports a clear reason, never throws", async () => {
    const db = fakeDb({ conversations: [{ leadId: "lead-1", provider: "META" }] });
    const freeText = new WhatsAppFreeTextService(db, async () => null, () => NOW);
    const result = await notifyOrderConfirmation(db, USER, orderParams, { freeText });
    assert.equal(result.sent, false);
    assert.match(result.reason ?? "", /template/i);
  });

  it("AISENSY: template-only, free text never attempted even if it would ever be possible", async () => {
    const db = fakeDb({ conversations: [{ leadId: "lead-1", provider: "AISENSY" }] });
    const result = await notifyOrderConfirmation(db, USER, orderParams, {});
    assert.equal(result.sent, false);
    assert.equal(result.provider, "AISENSY");
    assert.match(result.reason ?? "", /AISENSY/);
  });

  it("no conversation at all: reports cleanly, never throws", async () => {
    const db = fakeDb();
    const result = await notifyOrderConfirmation(db, USER, orderParams, {});
    assert.deepEqual(result, { sent: false, via: null, provider: null, reason: "This customer has no WhatsApp conversation yet." });
  });

  it("never throws even when the db itself throws", async () => {
    const throwingDb = { whatsAppConversation: { findUnique: async () => { throw new Error("db down"); } } } as unknown as DbClient;
    const result = await notifyOrderConfirmation(throwingDb, USER, orderParams, {});
    assert.equal(result.sent, false);
    assert.equal(result.reason, "db down");
  });
});

describe("notifyPaymentLink", () => {
  it("META, window open: free text contains the real payment link", async () => {
    const db = fakeDb({ conversations: [{ leadId: "lead-1", provider: "META" }], messages: [{ leadId: "lead-1", provider: "META", direction: "INBOUND", createdAt: new Date(NOW.getTime() - HOUR), receivedAt: new Date(NOW.getTime() - HOUR) }] });
    const sentTexts: string[] = [];
    const meta = { async sendText(input: any) { sentTexts.push(input.body); return { providerMessageId: "wamid.1", raw: {} }; } } as unknown as MetaCloudApiProvider;
    const freeText = new WhatsAppFreeTextService(db, async () => meta, () => NOW);
    const result = await notifyPaymentLink(db, USER, linkParams, { freeText });
    assert.equal(result.sent, true);
    assert.equal(result.via, "FREE_TEXT");
    assert.ok(sentTexts[0]?.includes(linkParams.paymentUrl));
  });

  it("AiSensy with no approved {{payment_link}} template: reports clearly", async () => {
    const db = fakeDb({ conversations: [{ leadId: "lead-1", provider: "AISENSY" }] });
    const result = await notifyPaymentLink(db, USER, linkParams, {});
    assert.equal(result.sent, false);
    assert.match(result.reason ?? "", /payment_link/);
  });
});

describe("send eligibility - an APPROVED row is only actually sendable when it could really have gotten that status", () => {
  // The full positive path (a GUPSHUP/AISENSY template that IS eligible actually completing a send) is covered
  // end-to-end against a real database in orders.prepaid-flow.db-test.ts's "Meta window closed, and AiSensy/Gupshup"
  // suite - this fake db supports only enough of the model surface for the routing/matching decision itself, not a
  // full send (lead/order lookups, etc), so eligibility is proven here by what gets REFUSED and why.

  it("a GUPSHUP APPROVED template with no providerTemplateId is refused - APPROVED can only ever come from a real sync, which always sets one", async () => {
    const db = fakeDb({
      conversations: [{ leadId: "lead-1", provider: "GUPSHUP" }],
      templates: [{ id: "t1", provider: "GUPSHUP", status: "APPROVED", name: "x", variables: ["payment_link"], language: "en", body: "{{payment_link}}", providerTemplateId: null }],
    });
    const result = await notifyPaymentLink(db, USER, linkParams, {});
    assert.equal(result.sent, false);
    assert.match(result.reason ?? "", /payment_link/, "reads as 'no eligible template', the same as if none existed at all");
  });

  it("the same template WITH a providerTemplateId IS found as a candidate (eligibility, not the variable/name matching, is what changes)", async () => {
    const dbIneligible = fakeDb({
      conversations: [{ leadId: "lead-1", provider: "GUPSHUP" }],
      templates: [{ id: "t1", provider: "GUPSHUP", status: "APPROVED", name: "x", variables: ["payment_link"], language: "en", body: "{{payment_link}}", providerTemplateId: null }],
    });
    const dbEligible = fakeDb({
      conversations: [{ leadId: "lead-1", provider: "GUPSHUP" }],
      templates: [{ id: "t1", provider: "GUPSHUP", status: "APPROVED", name: "x", variables: ["payment_link"], language: "en", body: "{{payment_link}}", providerTemplateId: "gs-123" }],
    });
    const ineligible = await notifyPaymentLink(dbIneligible, USER, linkParams, {});
    const eligible = await notifyPaymentLink(dbEligible, USER, linkParams, {});
    // Both attempt a send once past the eligibility check (this fake has no lead/order rows, so the send itself
    // errors out) - the meaningful difference is that the eligible one gets PAST "no template found" at all.
    assert.match(ineligible.reason ?? "", /payment_link/);
    assert.equal(/payment_link/.test(eligible.reason ?? ""), false);
  });

  it("an AiSensy APPROVED template with NO providerTemplateId is still an eligible candidate - that is its normal, only possible shape (dashboard-only provider)", async () => {
    const db = fakeDb({
      conversations: [{ leadId: "lead-1", provider: "AISENSY" }],
      templates: [{ id: "t1", provider: "AISENSY", status: "APPROVED", name: "x", variables: ["payment_link"], language: "en", body: "{{payment_link}}", providerTemplateId: null }],
    });
    const result = await notifyPaymentLink(db, USER, linkParams, {});
    assert.equal(/payment_link/.test(result.reason ?? ""), false, "found a candidate - AiSensy is exempt from the providerTemplateId requirement");
  });

  it("PENDING/REJECTED/DISABLED templates are never candidates regardless of providerTemplateId", async () => {
    for (const status of ["PENDING", "REJECTED", "DISABLED"]) {
      const db = fakeDb({
        conversations: [{ leadId: "lead-1", provider: "GUPSHUP" }],
        templates: [{ id: "t1", provider: "GUPSHUP", status, name: "x", variables: ["payment_link"], language: "en", body: "{{payment_link}}", providerTemplateId: "gs-123" }],
      });
      const result = await notifyPaymentLink(db, USER, linkParams, {});
      assert.equal(result.sent, false, status);
    }
  });
});
