import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isWebsiteChatWebhookAuthorised } from "./website-chat.controller.js";

const SECRET = "test-website-chat-secret-value";

function req(headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  return { headers, query } as any;
}

describe("Website Chat webhook authentication (Phase 2B)", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.WEBSITE_CHAT_WEBHOOK_SECRET;
    process.env.WEBSITE_CHAT_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.WEBSITE_CHAT_WEBHOOK_SECRET;
    else process.env.WEBSITE_CHAT_WEBHOOK_SECRET = previous;
  });

  it("9. a missing x-webhook-secret header is rejected", () => {
    assert.equal(isWebsiteChatWebhookAuthorised(req()), false);
  });

  it("9. an incorrect x-webhook-secret is rejected", () => {
    assert.equal(isWebsiteChatWebhookAuthorised(req({ "x-webhook-secret": "wrong" })), false);
  });

  it("the exact x-webhook-secret is accepted", () => {
    assert.equal(isWebsiteChatWebhookAuthorised(req({ "x-webhook-secret": SECRET })), true);
  });

  it("a bearer token carrying the same value is NOT accepted - no Authorization-based auth on this endpoint", () => {
    assert.equal(isWebsiteChatWebhookAuthorised(req({ authorization: `Bearer ${SECRET}` })), false);
  });

  it("a query-string secret is NOT accepted", () => {
    assert.equal(isWebsiteChatWebhookAuthorised(req({}, { secret: SECRET, "x-webhook-secret": SECRET })), false);
  });

  it("fails closed when WEBSITE_CHAT_WEBHOOK_SECRET is unset, even with a header present", () => {
    delete process.env.WEBSITE_CHAT_WEBHOOK_SECRET;
    assert.equal(isWebsiteChatWebhookAuthorised(req({ "x-webhook-secret": "anything" })), false);
  });
});
