import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebsiteChatWebhookService } from "./website-chat.service.js";
import { createInMemoryWebChatEventStore, inboundCustomerMessage } from "./website-chat.testkit.js";

function setup() {
  const kit = createInMemoryWebChatEventStore();
  const service = createWebsiteChatWebhookService(kit.store);
  return { kit, service };
}

function processed(result: Awaited<ReturnType<ReturnType<typeof createWebsiteChatWebhookService>["processWebhook"]>>) {
  assert.equal(result.outcome, "PROCESSED");
  return result as Extract<typeof result, { outcome: "PROCESSED" }>;
}

describe("Website Chat webhook service - conversation + message creation", () => {
  it("1. creates a new, anonymous conversation (leadId null) for an unknown externalConversationId", async () => {
    const { kit, service } = setup();
    const result = processed(await service.processWebhook(inboundCustomerMessage()));

    assert.equal(result.conversationCreated, true);
    assert.equal(result.leadId, null);
    assert.equal(kit.state.conversations.length, 1);
    assert.equal(kit.state.conversations[0]!.leadId, null);
    assert.equal(kit.state.conversations[0]!.mode, "AI");
  });

  it("2. stores the first message with the correct sender and body", async () => {
    const { kit, service } = setup();
    const result = processed(await service.processWebhook(inboundCustomerMessage({ sender: "customer", text: "Hello!" })));

    assert.equal(kit.state.messages.length, 1);
    assert.equal(kit.state.messages[0]!.sender, "CUSTOMER");
    assert.equal(kit.state.messages[0]!.body, "Hello!");
    assert.equal(kit.state.messages[0]!.conversationId, result.conversationId);
  });

  it("3. a duplicate externalMessageId is idempotent - no second message created", async () => {
    const { kit, service } = setup();
    await service.processWebhook(inboundCustomerMessage());
    const dup = await service.processWebhook(inboundCustomerMessage());

    assert.equal(dup.outcome, "DUPLICATE");
    assert.equal(kit.state.messages.length, 1);
    assert.equal(kit.state.conversations.length, 1);
  });

  it("4. a second message (new externalMessageId) updates the same conversation, not a new one", async () => {
    const { kit, service } = setup();
    const first = processed(await service.processWebhook(inboundCustomerMessage({ externalMessageId: "msg-1" })));
    const second = processed(await service.processWebhook(inboundCustomerMessage({ externalMessageId: "msg-2", text: "Second message" })));

    assert.equal(second.conversationId, first.conversationId);
    assert.equal(second.conversationCreated, false);
    assert.equal(kit.state.conversations.length, 1);
    assert.equal(kit.state.messages.length, 2);
  });

  it("a message with no externalMessageId is always stored (no dedupe possible, same as CallerDesk's null dedupeKey)", async () => {
    const { kit, service } = setup();
    await service.processWebhook(inboundCustomerMessage({ externalMessageId: null }));
    await service.processWebhook(inboundCustomerMessage({ externalMessageId: null }));

    assert.equal(kit.state.messages.length, 2, "both deliveries stored - no stable id to dedupe on");
  });
});

describe("Website Chat webhook service - identity and Lead matching", () => {
  it("5. customer identity arriving on a later message attaches the Lead to the existing conversation", async () => {
    const { kit, service } = setup();
    const first = processed(await service.processWebhook(inboundCustomerMessage({ externalMessageId: "msg-1" })));
    assert.equal(first.leadId, null);

    const second = processed(
      await service.processWebhook(
        inboundCustomerMessage({ externalMessageId: "msg-2", customer: { name: "Priya Shah", mobile: "9876543210" } }),
      ),
    );

    assert.equal(second.conversationId, first.conversationId);
    assert.ok(second.leadId, "leadId should now be set");
    assert.equal(kit.state.conversations.length, 1);
  });

  it("6. an existing Lead (from ANY source) is matched globally by normalized mobile, not created again", async () => {
    const { kit, service } = setup();
    const existingLeadId = kit.addLead({ normalizedMobile: "9876543210", ownerId: "owner-1" });

    const result = processed(
      await service.processWebhook(inboundCustomerMessage({ customer: { mobile: "+91 98765 43210" } })),
    );

    assert.equal(result.leadId, existingLeadId);
    assert.equal(result.leadCreated, false);
    assert.equal(kit.state.leads.length, 1, "no second Lead created");
  });

  it("7. no existing Lead -> a new Lead is created only once identity is actually supplied", async () => {
    const { kit, service } = setup();

    const anonymous = processed(await service.processWebhook(inboundCustomerMessage({ externalMessageId: "msg-1" })));
    assert.equal(anonymous.leadId, null);
    assert.equal(kit.state.leads.length, 0, "no Lead for an anonymous visitor who gave no identity");

    const identified = processed(
      await service.processWebhook(
        inboundCustomerMessage({ externalMessageId: "msg-2", customer: { name: "New Visitor", mobile: "9000000001" } }),
      ),
    );
    assert.equal(identified.leadCreated, true);
    assert.equal(kit.state.leads.length, 1);
  });

  it("ambiguous phone match (2+ leads) never guesses - leadId stays null", async () => {
    const { kit, service } = setup();
    kit.addLead({ normalizedMobile: "9876543210", ownerId: "owner-1" });
    kit.addLead({ normalizedMobile: "919876543210", ownerId: "owner-2" });

    const result = processed(
      await service.processWebhook(inboundCustomerMessage({ customer: { mobile: "9876543210" } })),
    );

    assert.equal(result.leadId, null);
    assert.equal(kit.state.leads.length, 2, "no third Lead created either");
  });

  it("9. the same Lead can be attached to multiple, separate WebChatConversation rows", async () => {
    const { kit, service } = setup();
    const leadId = kit.addLead({ normalizedMobile: "9876543210", ownerId: null });

    await service.processWebhook(inboundCustomerMessage({ externalConversationId: "session-A", customer: { mobile: "9876543210" } }));
    await service.processWebhook(inboundCustomerMessage({ externalConversationId: "session-B", customer: { mobile: "9876543210" } }));

    assert.equal(kit.state.conversations.length, 2);
    assert.ok(kit.state.conversations.every((c) => c.leadId === leadId));
  });
});

describe("Website Chat webhook service - mode and misc", () => {
  it("never auto-switches AI -> HUMAN just because messages arrive", async () => {
    const { kit, service } = setup();
    for (let i = 0; i < 5; i++) {
      await service.processWebhook(inboundCustomerMessage({ externalMessageId: `msg-${i}` }));
    }
    assert.equal(kit.state.conversations[0]!.mode, "AI");
  });

  it("intent/productInterest are stored when supplied, left unchanged when omitted", async () => {
    const { kit, service } = setup();
    await service.processWebhook(inboundCustomerMessage({ externalMessageId: "msg-1", intent: "buy", productInterest: "Immunity Booster" }));
    assert.equal(kit.state.conversations[0]!.intent, "buy");
    assert.equal(kit.state.conversations[0]!.productInterest, "Immunity Booster");

    await service.processWebhook(inboundCustomerMessage({ externalMessageId: "msg-2" }));
    assert.equal(kit.state.conversations[0]!.intent, "buy", "not cleared by a message that omits it");
  });

  it("rejects an invalid payload without touching the store", async () => {
    const { kit, service } = setup();
    const result = await service.processWebhook({ sender: "customer" });

    assert.equal(result.outcome, "INVALID");
    assert.equal(kit.state.conversations.length, 0);
    assert.equal(kit.state.messages.length, 0);
  });

  it("an AI-sender message is stored with sender AI, not CUSTOMER", async () => {
    const { kit, service } = setup();
    await service.processWebhook(inboundCustomerMessage({ sender: "ai", text: "Here are our bestsellers..." }));
    assert.equal(kit.state.messages[0]!.sender, "AI");
  });
});

describe("Website Chat - Source (test 8)", () => {
  it("Leads created from the chatbot use the Source name 'Website Chat'", async () => {
    const { WEBSITE_CHAT_SOURCE_NAME, WEBSITE_CHAT_SOURCE_CODE } = await import("./website-chat.store.js");
    assert.equal(WEBSITE_CHAT_SOURCE_NAME, "Website Chat");
    assert.equal(WEBSITE_CHAT_SOURCE_CODE, "website_chat");
  });
});

describe("Website Chat webhook service - handoff (Phase 2B)", () => {
  it("1. a customer message without handoff keeps the conversation in AI mode", async () => {
    const { kit, service } = setup();
    processed(await service.processWebhook(inboundCustomerMessage({ externalMessageId: "msg-1" })));
    assert.equal(kit.state.conversations[0]!.mode, "AI");
  });

  it("2. an AI message without handoff keeps the conversation in AI mode", async () => {
    const { kit, service } = setup();
    processed(await service.processWebhook(inboundCustomerMessage({ sender: "ai", text: "Hello", externalMessageId: "ai-1" })));
    assert.equal(kit.state.conversations[0]!.mode, "AI");
  });

  it("3 and 5. handoff: true switches an existing conversation to HUMAN and keeps its existing data", async () => {
    const { kit, service } = setup();
    const leadId = kit.addLead({ normalizedMobile: "9876543210", ownerId: null });
    processed(
      await service.processWebhook(
        inboundCustomerMessage({ externalMessageId: "msg-1", intent: "browse", productInterest: "Immune Care", customer: { mobile: "9876543210" } }),
      ),
    );

    const result = processed(await service.processWebhook(inboundCustomerMessage({ externalMessageId: "msg-2", handoff: true })));

    const conversation = kit.state.conversations[0]!;
    assert.equal(conversation.mode, "HUMAN");
    assert.equal(conversation.leadId, leadId, "lead association preserved");
    assert.equal(conversation.intent, "browse", "intent preserved when not supplied");
    assert.equal(conversation.productInterest, "Immune Care", "product interest preserved when not supplied");
    assert.equal(kit.state.conversations.length, 1, "no duplicate conversation");
    assert.equal(result.handoffAccepted, true);
  });

  it("4. handoff: true on a brand-new conversation creates it and then sets HUMAN", async () => {
    const { kit, service } = setup();
    const result = processed(await service.processWebhook(inboundCustomerMessage({ handoff: true })));

    assert.equal(result.conversationCreated, true);
    assert.equal(kit.state.conversations.length, 1);
    assert.equal(kit.state.conversations[0]!.mode, "HUMAN");
    assert.equal(kit.state.messages.length, 1);
  });

  it("6. a duplicate webhook carrying handoff: true does not create a duplicate message or conversation", async () => {
    const { kit, service } = setup();
    await service.processWebhook(inboundCustomerMessage({ externalMessageId: "msg-1", handoff: true }));
    const retry = await service.processWebhook(inboundCustomerMessage({ externalMessageId: "msg-1", handoff: true }));

    assert.equal(retry.outcome, "DUPLICATE");
    assert.equal(kit.state.messages.length, 1);
    assert.equal(kit.state.conversations.length, 1);
    assert.equal(kit.state.conversations[0]!.mode, "HUMAN");
  });

  it("7. a stale duplicate handoff never flips a conversation back to HUMAN after an agent returned it to AI", async () => {
    const { kit, service } = setup();
    await service.processWebhook(inboundCustomerMessage({ externalMessageId: "msg-1", handoff: true }));
    kit.state.conversations[0]!.mode = "AI"; // the agent later clicks "Return to AI"

    const retry = await service.processWebhook(inboundCustomerMessage({ externalMessageId: "msg-1", handoff: true }));

    assert.equal(retry.outcome, "DUPLICATE");
    assert.equal(kit.state.conversations[0]!.mode, "AI");
  });

  it("8. handoff: false does not switch to HUMAN", async () => {
    const { kit, service } = setup();
    const result = processed(await service.processWebhook(inboundCustomerMessage({ handoff: false })));
    assert.equal(kit.state.conversations[0]!.mode, "AI");
    assert.equal(result.handoffAccepted, false);
  });

  it("10. a non-boolean handoff value is rejected and nothing is stored", async () => {
    for (const bad of ["true", 1, "yes", null]) {
      const { kit, service } = setup();
      const result = await service.processWebhook(inboundCustomerMessage({ handoff: bad }));
      assert.equal(result.outcome, "INVALID", `handoff=${JSON.stringify(bad)} must be rejected`);
      assert.equal(kit.state.conversations.length, 0);
      assert.equal(kit.state.messages.length, 0);
    }
  });

  it("the sender contract is unchanged - lowercase customer/ai only, uppercase is rejected", async () => {
    const { service } = setup();
    assert.equal((await service.processWebhook(inboundCustomerMessage({ sender: "CUSTOMER" }))).outcome, "INVALID");
    assert.equal((await service.processWebhook(inboundCustomerMessage({ sender: "AI" }))).outcome, "INVALID");
  });
});
