import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import express from "express";
import { createCallerDeskWebhookHandler } from "./callerdesk.controller.js";
import { createCallerDeskRouter } from "./callerdesk.routes.js";
import type { CallerDeskWebhookResult, CallerDeskWebhookService } from "./callerdesk.service.js";
import { inboundCallReport } from "./callerdesk.testkit.js";

/**
 * Exercises the real router + controller over HTTP with a fake service, so no database is involved.
 */

let server: Server | undefined;
let baseUrl = "";
let nextResult: CallerDeskWebhookResult = { outcome: "UNMATCHED", webhookEventId: "e1", reason: "NO_LEAD_MATCH" };
let received: unknown[] = [];
let logs: string[] = [];
const originalToken = process.env.CALLERDESK_WEBHOOK_TOKEN;

const fakeService: CallerDeskWebhookService = {
  async processWebhook(body: unknown) {
    received.push(body);
    return nextResult;
  },
};

beforeEach(async () => {
  received = [];
  logs = [];
  delete process.env.CALLERDESK_WEBHOOK_TOKEN;
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);

  const app = express();
  app.use(express.json());
  app.use("/api/webhooks/callerdesk", createCallerDeskRouter(createCallerDeskWebhookHandler(() => fakeService)));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/webhooks/callerdesk`;
});

afterEach(async () => {
  mock.restoreAll();
  if (originalToken === undefined) delete process.env.CALLERDESK_WEBHOOK_TOKEN;
  else process.env.CALLERDESK_WEBHOOK_TOKEN = originalToken;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
});

const post = (body: unknown, url = baseUrl) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/webhooks/callerdesk", () => {
  it("accepts a valid JSON payload without authentication and hands it to the service", async () => {
    nextResult = { outcome: "PROCESSED", webhookEventId: "e1", callId: "c1", correlation: "PHONE_NUMBER", callCreated: true, recording: "created", activityCreated: true };

    const res = await post(inboundCallReport());
    const body = (await res.json()) as Record<string, unknown>;

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(received[0], inboundCallReport());
    // Nothing submitted (numbers, sids, URLs) or internal (ids, correlation) is echoed back.
    const text = JSON.stringify(body);
    for (const leaked of ["9876543210", "1672649960", "callrecords", "c1", "PHONE_NUMBER"]) {
      assert.ok(!text.includes(leaked), `response must not echo ${leaked}`);
    }
  });

  it("also accepts URL-encoded bodies (tolerant fallback)", async () => {
    nextResult = { outcome: "UNMATCHED", webhookEventId: "e1", reason: "NO_LEAD_MATCH" };
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "abc.1", Status: "ANSWER" }).toString(),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(received[0], { CallSid: "abc.1", Status: "ANSWER" });
  });

  it("returns 200 for duplicates, unmatched and ignored events", async () => {
    for (const outcome of [
      { outcome: "DUPLICATE", webhookEventId: "e1" },
      { outcome: "UNMATCHED", webhookEventId: "e1", reason: "NO_LEAD_MATCH" },
      { outcome: "IGNORED", webhookEventId: "e1", reason: "UNRECOGNISED_LIVE_STATUS" },
    ] as CallerDeskWebhookResult[]) {
      nextResult = outcome;
      assert.equal((await post(inboundCallReport())).status, 200, outcome.outcome);
    }
  });

  it("returns 400 with a generic message for an invalid payload", async () => {
    nextResult = { outcome: "INVALID", reason: "invalid or missing fields: callsid (secret-detail)" };
    const res = await post({ nope: true });
    const body = (await res.json()) as { message: string; data: unknown };

    assert.equal(res.status, 400);
    assert.equal(body.message, "Invalid webhook payload");
    assert.equal(body.data, null);
    assert.ok(!JSON.stringify(body).includes("secret-detail"));
  });

  it("returns a generic 500 (no stack, no error object) when processing fails", async () => {
    nextResult = { outcome: "FAILED" };
    const res = await post(inboundCallReport());
    const text = await res.text();

    assert.equal(res.status, 500);
    assert.equal((JSON.parse(text) as { message: string }).message, "Webhook processing failed");
    assert.ok(!/stack|Error:|postgres|prisma/i.test(text));
  });

  it("never lets a thrown service error reach the global error handler", async () => {
    const throwing: CallerDeskWebhookService = {
      async processWebhook() {
        throw new Error("connection to FAKE-LEAK-CANARY failed");
      },
    };
    const app = express();
    app.use(express.json());
    app.use("/hook", createCallerDeskRouter(createCallerDeskWebhookHandler(() => throwing)));
    const s = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/hook`;
      const res = await post(inboundCallReport(), url);
      const text = await res.text();
      assert.equal(res.status, 500);
      assert.ok(!text.includes("FAKE-LEAK-CANARY"));
      assert.ok(!logs.join("\n").includes("FAKE-LEAK-CANARY"));
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it("rejects non-POST methods with 405 and an Allow header", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(baseUrl, { method });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get("allow"), "POST", method);
    }
    assert.equal(received.length, 0, "the service is never invoked for non-POST requests");
  });
});

describe("optional CALLERDESK_WEBHOOK_TOKEN", () => {
  it("is off by default: requests without a token are accepted", async () => {
    nextResult = { outcome: "UNMATCHED", webhookEventId: "e1", reason: "NO_LEAD_MATCH" };
    assert.equal((await post(inboundCallReport())).status, 200);
  });

  it("when set, rejects missing or wrong tokens with 401 and never reaches the service", async () => {
    process.env.CALLERDESK_WEBHOOK_TOKEN = "correct-horse-battery";
    nextResult = { outcome: "UNMATCHED", webhookEventId: "e1", reason: "NO_LEAD_MATCH" };

    assert.equal((await post(inboundCallReport())).status, 401);
    assert.equal((await post(inboundCallReport(), `${baseUrl}?token=wrong`)).status, 401);
    assert.equal((await post(inboundCallReport(), `${baseUrl}?token=`)).status, 401);
    assert.equal((await post(inboundCallReport(), `${baseUrl}?token=correct-horse-batter`)).status, 401);
    assert.equal(received.length, 0);
  });

  it("when set, accepts the exact token and never logs it", async () => {
    process.env.CALLERDESK_WEBHOOK_TOKEN = "correct-horse-battery";
    nextResult = { outcome: "UNMATCHED", webhookEventId: "e1", reason: "NO_LEAD_MATCH" };

    await post(inboundCallReport(), `${baseUrl}?token=wrong-guess`);
    assert.equal((await post(inboundCallReport(), `${baseUrl}?token=correct-horse-battery`)).status, 200);
    assert.equal(received.length, 1);

    const all = logs.join("\n");
    assert.ok(!all.includes("correct-horse-battery"), "the configured token is never logged");
    assert.ok(!all.includes("wrong-guess"), "a supplied token is never logged");
  });
});
