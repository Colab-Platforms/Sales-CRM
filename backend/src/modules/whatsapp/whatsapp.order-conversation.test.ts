import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DbClient } from "@/lib/leadScope.js";
import WhatsAppOrderConversationService, { computeOrderState } from "./whatsapp.order-conversation.service.js";
import type { OrderExtraction } from "./whatsapp.ai.types.js";
import type { OrderDraft } from "./whatsapp.conversation.types.js";

// ---- computeOrderState: pure, forward-advancing state derivation ----

describe("computeOrderState", () => {
  it("advances strictly with the data present, one gap at a time", () => {
    assert.equal(computeOrderState({}), "DISCOVERY");
    assert.equal(computeOrderState({ productId: "p1" }), "PRODUCT_SELECTED");
    assert.equal(computeOrderState({ productId: "p1", quantity: 2 }), "QUANTITY_SELECTED");
    assert.equal(computeOrderState({ productId: "p1", quantity: 2, customerName: "Ravi", phone: "+91" }), "ADDRESS_REQUIRED");
    assert.equal(computeOrderState({ productId: "p1", quantity: 2, customerName: "Ravi", phone: "+91", addressLine: "A", city: "Mumbai", state: "MH", pincode: "400053" }), "ADDRESS_CONFIRMED");
    assert.equal(
      computeOrderState({ productId: "p1", quantity: 2, customerName: "Ravi", phone: "+91", addressLine: "A", city: "Mumbai", state: "MH", pincode: "400053", paymentMethod: "COD" }),
      "ORDER_REVIEW",
    );
  });
});

// ---- Fake db + injected extractFn/ordersService/getMetaProvider, no live credentials anywhere ----

const CATALOG_PRODUCT = { id: "prod-1", name: "Immunity Booster", sku: "IMM-1", basePrice: "499.00", variants: [{ id: "var-1", name: "500ml", sku: "IMM-1-500", price: "499.00" }] };

function fakeDb() {
  const conversations: any[] = [{ leadId: "lead-1", provider: "AISENSY", mode: "AI", assignedToId: "sales-a", lastReadAt: null, orderState: "DISCOVERY", orderDraft: null, aiSuggestedReply: null, lastAiHandoffReason: null, createdOrderId: null }];
  const messages: any[] = [];
  const activities: any[] = [];
  const users = [{ id: "sales-a", role: "SALESPERSON", email: "a@example.com" }];
  const leads = [{ id: "lead-1", normalizedMobile: "+919876543210" }];

  const db = {
    whatsAppConversation: {
      async findUnique({ where, select }: any) {
        const row = conversations.find((c) => c.leadId === where.leadId);
        if (!row) return null;
        if (!select) return row;
        const out: any = {};
        for (const k of Object.keys(select)) out[k] = row[k];
        return out;
      },
      async update({ where, data }: any) {
        const row = conversations.find((c) => c.leadId === where.leadId);
        Object.assign(row, data);
        return row;
      },
      async updateMany({ where, data }: any) {
        const row = conversations.find((c) => c.leadId === where.leadId);
        if (!row) return { count: 0 };
        const stateMatches = !where.orderState || (where.orderState.in ? where.orderState.in.includes(row.orderState) : where.orderState.not ? row.orderState !== where.orderState.not : row.orderState === where.orderState);
        if (!stateMatches) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    whatsAppMessage: {
      async findMany() {
        return messages;
      },
    },
    product: {
      async count() {
        return 1;
      },
      async findMany() {
        return [CATALOG_PRODUCT];
      },
    },
    user: {
      async findUnique({ where }: any) {
        return users.find((u) => u.id === where.id) ?? null;
      },
    },
    lead: {
      async findUnique({ where }: any) {
        return leads.find((l) => l.id === where.id) ?? null;
      },
    },
    activity: {
      async create({ data }: any) {
        activities.push(data);
        return data;
      },
    },
  } as unknown as DbClient;

  return { db, conversations, messages, activities };
}

const baseExtraction = (overrides: Partial<OrderExtraction> = {}): OrderExtraction => ({
  confidence: 0.9,
  customerWantsHuman: false,
  unsupportedRequest: false,
  customerConfirmed: false,
  suggestedReply: "How many would you like?",
  ...overrides,
});

// The orchestrator depends on the AIProvider interface only - a fake provider is all a test needs.
const fakeAi = (fn: (input: any) => Promise<OrderExtraction>) => () => ({ name: "fake", extractOrderInfo: fn });

const fakeOrdersService = (createManualOrder: (...args: any[]) => Promise<any>) => ({ createManualOrder });

describe("WhatsAppOrderConversationService.processInboundForAi - extraction and draft merging", () => {
  it("extracts a product mention and matches it against the catalog by name", async () => {
    const { db, conversations } = fakeDb();
    const extractFn = async () => baseExtraction({ productMention: "Immunity Booster" });
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), fakeOrdersService(async () => { throw new Error("should not be called"); }));
    await service.processInboundForAi({ leadId: "lead-1", messageText: "I want Immunity Booster", conversation: conversations[0] });
    assert.equal(conversations[0].orderDraft.productId, "prod-1");
    assert.equal(conversations[0].orderState, "PRODUCT_SELECTED");
  });

  it("extracts quantity, keeping the previously selected product", async () => {
    const { db, conversations } = fakeDb();
    conversations[0].orderDraft = { productId: "prod-1", productName: "Immunity Booster", unitPrice: "499.00" };
    conversations[0].orderState = "PRODUCT_SELECTED";
    const extractFn = async () => baseExtraction({ quantity: 2 });
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), fakeOrdersService(async () => { throw new Error("should not be called"); }));
    await service.processInboundForAi({ leadId: "lead-1", messageText: "2", conversation: conversations[0] });
    assert.equal(conversations[0].orderDraft.quantity, 2);
    assert.equal(conversations[0].orderDraft.productId, "prod-1"); // never erased by an extraction that didn't mention it
    assert.equal(conversations[0].orderState, "QUANTITY_SELECTED");
  });

  it("extracts an address and advances past ADDRESS_REQUIRED once complete", async () => {
    const { db, conversations } = fakeDb();
    conversations[0].orderDraft = { productId: "prod-1", quantity: 2, customerName: "Ravi", phone: "+919876543210" };
    conversations[0].orderState = "QUANTITY_SELECTED";
    const extractFn = async () => baseExtraction({ addressLine: "12 MG Road", city: "Mumbai", state: "MH", pincode: "400053" });
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), fakeOrdersService(async () => { throw new Error("should not be called"); }));
    await service.processInboundForAi({ leadId: "lead-1", messageText: "12 MG Road, Mumbai, MH 400053", conversation: conversations[0] });
    assert.equal(conversations[0].orderState, "ADDRESS_CONFIRMED");
  });
});

describe("WhatsAppOrderConversationService.processInboundForAi - handoff conditions", () => {
  it("hands off to a human on low confidence, without touching the draft", async () => {
    const { db, conversations } = fakeDb();
    const extractFn = async () => baseExtraction({ confidence: 0.2, productMention: "Immunity Booster" });
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), fakeOrdersService(async () => { throw new Error("should not be called"); }));
    await service.processInboundForAi({ leadId: "lead-1", messageText: "hmm not sure", conversation: conversations[0] });
    assert.equal(conversations[0].mode, "HUMAN");
    assert.match(conversations[0].lastAiHandoffReason, /Low confidence/);
    assert.equal(conversations[0].orderDraft, null);
  });

  it("hands off when the customer explicitly asks for a human", async () => {
    const { db, conversations } = fakeDb();
    const extractFn = async () => baseExtraction({ customerWantsHuman: true });
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), fakeOrdersService(async () => { throw new Error("should not be called"); }));
    await service.processInboundForAi({ leadId: "lead-1", messageText: "let me talk to a person", conversation: conversations[0] });
    assert.equal(conversations[0].mode, "HUMAN");
    assert.match(conversations[0].lastAiHandoffReason, /human/);
  });

  it("hands off on an unsupported request", async () => {
    const { db, conversations } = fakeDb();
    const extractFn = async () => baseExtraction({ unsupportedRequest: true });
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), fakeOrdersService(async () => { throw new Error("should not be called"); }));
    await service.processInboundForAi({ leadId: "lead-1", messageText: "my last order never arrived, I want a refund", conversation: conversations[0] });
    assert.equal(conversations[0].mode, "HUMAN");
  });

  it("hands off, rather than crashing, when the AI call itself fails", async () => {
    const { db, conversations } = fakeDb();
    const extractFn = async () => { throw new Error("network down"); };
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), fakeOrdersService(async () => { throw new Error("should not be called"); }));
    await assert.doesNotReject(() => service.processInboundForAi({ leadId: "lead-1", messageText: "hi", conversation: conversations[0] }));
    assert.equal(conversations[0].mode, "HUMAN");
  });

  it("hands off immediately, without calling the AI, when no salesperson is assigned", async () => {
    const { db, conversations } = fakeDb();
    conversations[0].assignedToId = null;
    let extractCalled = false;
    const extractFn = async () => { extractCalled = true; return baseExtraction(); };
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), fakeOrdersService(async () => { throw new Error("should not be called"); }));
    await service.processInboundForAi({ leadId: "lead-1", messageText: "hi", conversation: conversations[0] });
    assert.equal(conversations[0].mode, "HUMAN");
    assert.equal(extractCalled, false);
  });
});

describe("WhatsAppOrderConversationService.processInboundForAi - order confirmation", () => {
  const readyDraft: OrderDraft = { productId: "prod-1", productName: "Immunity Booster", unitPrice: "499.00", quantity: 2, customerName: "Ravi", phone: "+919876543210", addressLine: "12 MG Road", city: "Mumbai", state: "MH", pincode: "400053", paymentMethod: "COD" };

  it("does NOT create an order just because the model says customerConfirmed=true - the raw message must also contain a real confirmation keyword", async () => {
    const { db, conversations } = fakeDb();
    conversations[0].orderDraft = readyDraft;
    conversations[0].orderState = "ORDER_REVIEW";
    let called = false;
    const extractFn = async () => baseExtraction({ customerConfirmed: true });
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), fakeOrdersService(async () => { called = true; return { order: { id: "order-1", orderNumber: "CRM-1" } }; }));
    // A message that merely sounds affirmative in tone but isn't an actual confirmation.
    await service.processInboundForAi({ leadId: "lead-1", messageText: "sounds good, tell me more", conversation: conversations[0] });
    assert.equal(called, false);
    assert.equal(conversations[0].orderState, "ORDER_REVIEW");
  });

  it("creates the order once the customer's own message is an explicit confirmation and the model agrees", async () => {
    const { db, conversations, activities } = fakeDb();
    conversations[0].orderDraft = readyDraft;
    conversations[0].orderState = "ORDER_REVIEW";
    let capturedInput: any = null;
    const extractFn = async () => baseExtraction({ customerConfirmed: true });
    const service = new WhatsAppOrderConversationService(
      db,
      fakeAi(extractFn),
      fakeOrdersService(async (_actor, input) => {
        capturedInput = input;
        return { order: { id: "order-1", orderNumber: "CRM-1" } };
      }),
    );
    await service.processInboundForAi({ leadId: "lead-1", messageText: "yes, please place the order", conversation: conversations[0] });

    assert.equal(conversations[0].orderState, "ORDER_CREATED");
    assert.equal(conversations[0].createdOrderId, "order-1");
    assert.equal(capturedInput.leadId, "lead-1");
    assert.equal(capturedInput.items[0].productId, "prod-1");
    assert.equal(capturedInput.items[0].quantity, 2);
    assert.equal(capturedInput.paymentMethod, "COD");
    assert.ok(activities.some((a) => a.type === "ORDER_CREATED" && a.source === "SYSTEM"));
  });

  it("never creates two orders for the same conversation, even if triggered twice", async () => {
    const { db, conversations } = fakeDb();
    conversations[0].orderDraft = readyDraft;
    conversations[0].orderState = "ORDER_REVIEW";
    let callCount = 0;
    const extractFn = async () => baseExtraction({ customerConfirmed: true });
    const service = new WhatsAppOrderConversationService(
      db,
      fakeAi(extractFn),
      fakeOrdersService(async () => {
        callCount += 1;
        return { order: { id: "order-1", orderNumber: "CRM-1" } };
      }),
    );
    await service.processInboundForAi({ leadId: "lead-1", messageText: "yes confirm", conversation: { ...conversations[0] } });
    // A second trigger for the same conversation (e.g. a duplicate webhook that somehow reached
    // here, or a race with the human confirm route) - orderState is now ORDER_CREATED already.
    const confirmedAgain = await service.confirmDraftOrder("lead-1");
    assert.equal(callCount, 1);
    assert.equal(confirmedAgain, null);
  });

  it("rolls back to CUSTOMER_CONFIRMED (not stuck) when order creation itself throws, so a retry can succeed", async () => {
    const { db, conversations } = fakeDb();
    conversations[0].orderDraft = readyDraft;
    conversations[0].orderState = "ORDER_REVIEW";
    let attempt = 0;
    const orders = fakeOrdersService(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("db down");
      return { order: { id: "order-1", orderNumber: "CRM-1" } };
    });
    const extractFn = async () => baseExtraction({ customerConfirmed: true });
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), orders);
    await service.processInboundForAi({ leadId: "lead-1", messageText: "yes confirm", conversation: conversations[0] });
    assert.equal(conversations[0].orderState, "CUSTOMER_CONFIRMED");
    assert.equal(conversations[0].createdOrderId, null);

    const retried = await service.confirmDraftOrder("lead-1");
    assert.equal(retried, "order-1");
    assert.equal(conversations[0].orderState, "ORDER_CREATED");
  });

  it("does not create an order for an incomplete draft even if orderState/customerConfirmed claim it's ready", async () => {
    const { db, conversations } = fakeDb();
    conversations[0].orderDraft = { productId: "prod-1" }; // missing quantity/unitPrice/paymentMethod
    conversations[0].orderState = "CUSTOMER_CONFIRMED";
    const result = await new WhatsAppOrderConversationService(db, fakeAi(async () => baseExtraction()), fakeOrdersService(async () => { throw new Error("should not be called"); })).confirmDraftOrder("lead-1");
    assert.equal(result, null);
  });
});

describe("WhatsAppOrderConversationService.processInboundForAi - reply delivery is provider-gated", () => {
  it("auto-sends the suggested reply as free text only when the active provider is Meta", async () => {
    const { db, conversations } = fakeDb();
    conversations[0].provider = "META";
    let sentText: string | null = null;
    const fakeMetaProvider = { sendText: async ({ body }: any) => { sentText = body; return { providerMessageId: "wamid.1", raw: {} }; } };
    const getMetaProvider = async () => fakeMetaProvider as any;
    const extractFn = async () => baseExtraction({ suggestedReply: "Which quantity would you like?" });
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), fakeOrdersService(async () => { throw new Error("should not be called"); }), getMetaProvider as any);
    await service.processInboundForAi({ leadId: "lead-1", messageText: "immunity booster", conversation: conversations[0] });
    assert.equal(sentText, "Which quantity would you like?");
    assert.equal(conversations[0].aiSuggestedReply, null); // sent, not left as a draft
  });

  it("never auto-sends on AiSensy/Gupshup - the reply is stored as a draft for a human to send instead", async () => {
    const { db, conversations } = fakeDb();
    conversations[0].provider = "AISENSY";
    const getMetaProvider = async () => { throw new Error("must not be called for a non-Meta conversation"); };
    const extractFn = async () => baseExtraction({ suggestedReply: "Which quantity would you like?" });
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), fakeOrdersService(async () => { throw new Error("should not be called"); }), getMetaProvider as any);
    await service.processInboundForAi({ leadId: "lead-1", messageText: "immunity booster", conversation: conversations[0] });
    assert.equal(conversations[0].aiSuggestedReply, "Which quantity would you like?");
  });
});

describe("Secrets never reach the AI prompt", () => {
  it("the extraction call's input carries only conversation text, current draft, and catalog names/prices - no token/credential field anywhere", async () => {
    const { db, conversations } = fakeDb();
    let capturedInput: any = null;
    const extractFn = async (input: any) => {
      capturedInput = input;
      return baseExtraction();
    };
    const service = new WhatsAppOrderConversationService(db, fakeAi(extractFn), fakeOrdersService(async () => { throw new Error("should not be called"); }));
    await service.processInboundForAi({ leadId: "lead-1", messageText: "hi", conversation: conversations[0] });

    const serialized = JSON.stringify(capturedInput).toLowerCase();
    for (const forbidden of ["token", "secret", "password", "apikey", "api_key", "credential"]) {
      assert.equal(serialized.includes(forbidden), false, `AI extraction input must never contain "${forbidden}"`);
    }
  });
});
