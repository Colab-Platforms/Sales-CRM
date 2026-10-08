import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { httpAgentReplyDelivery } from "./webchat.chatbotClient.js";

describe("httpAgentReplyDelivery - CRM -> chatbot agent reply delivery", () => {
  it("returns false (never throws) when WEBSITE_CHAT_CHATBOT_BASE_URL/WEBSITE_CHAT_AGENT_REPLY_SECRET are unset", async () => {
    const prevUrl = process.env.WEBSITE_CHAT_CHATBOT_BASE_URL;
    const prevSecret = process.env.WEBSITE_CHAT_AGENT_REPLY_SECRET;
    delete process.env.WEBSITE_CHAT_CHATBOT_BASE_URL;
    delete process.env.WEBSITE_CHAT_AGENT_REPLY_SECRET;

    try {
      const delivered = await httpAgentReplyDelivery.deliver({
        externalConversationId: "web-session-1",
        text: "Hello",
        agentName: "sp1",
      });
      assert.equal(delivered, false);
    } finally {
      if (prevUrl !== undefined) process.env.WEBSITE_CHAT_CHATBOT_BASE_URL = prevUrl;
      if (prevSecret !== undefined) process.env.WEBSITE_CHAT_AGENT_REPLY_SECRET = prevSecret;
    }
  });

  it("returns false (never throws) when the chatbot is unreachable", async () => {
    const prevUrl = process.env.WEBSITE_CHAT_CHATBOT_BASE_URL;
    const prevSecret = process.env.WEBSITE_CHAT_AGENT_REPLY_SECRET;
    process.env.WEBSITE_CHAT_CHATBOT_BASE_URL = "http://127.0.0.1:1"; // nothing listens here
    process.env.WEBSITE_CHAT_AGENT_REPLY_SECRET = "test-secret";

    try {
      const delivered = await httpAgentReplyDelivery.deliver({
        externalConversationId: "web-session-1",
        text: "Hello",
        agentName: "sp1",
      });
      assert.equal(delivered, false);
    } finally {
      if (prevUrl === undefined) delete process.env.WEBSITE_CHAT_CHATBOT_BASE_URL;
      else process.env.WEBSITE_CHAT_CHATBOT_BASE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.WEBSITE_CHAT_AGENT_REPLY_SECRET;
      else process.env.WEBSITE_CHAT_AGENT_REPLY_SECRET = prevSecret;
    }
  });
});
