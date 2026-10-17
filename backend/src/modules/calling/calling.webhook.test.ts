import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import express, { type Request, type Response } from "express";
import { createCallerDeskWebhookHandler } from "../webhooks/callerdesk/callerdesk.controller.js";
import type { CallerDeskWebhookResult, CallerDeskWebhookService } from "../webhooks/callerdesk/callerdesk.service.js";
import { createReceiveCallWebhook } from "./calling.controller.js";
import { summarizeWebhookForLog } from "./calling.webhook.log.js";

// The shared CallerDesk URL (/api/calling/webhooks/callerdesk): response codes and logging, exercised over
// HTTP against fakes - no database, no network beyond localhost.

let server: Server | undefined;
let baseUrl = "";

async function start(handler: (req: Request, res: Response) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.post("/hook", handler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/hook`;
}

const post = (body: unknown = { CallSid: "x.1" }) =>
  fetch(baseUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  const quiet = () => undefined;
  mock.method(console, "log", quiet);
  mock.method(console, "info", quiet);
  mock.method(console, "warn", quiet);
  mock.method(console, "error", quiet);
});
afterEach(async () => {
  mock.restoreAll();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("shared webhook URL: routing and acknowledgement", () => {
  const forwardingDeps = (over: { secretOk?: boolean; handled?: boolean | "throw"; forward?: (req: Request, res: Response) => Promise<void> }) => {
    const calls = { handle: 0, forward: 0 };
    const deps = {
      service: {
        verifyWebhookSecret: () => over.secretOk ?? true,
        handleCallWebhook: async () => {
          calls.handle += 1;
          if (over.handled === "throw") throw new Error("boom");
          return over.handled ?? true;
        },
      },
      forward: async (req: Request, res: Response) => {
        calls.forward += 1;
        await (over.forward ?? (async (_q, r) => void r.status(200).json({ forwarded: true })))(req, res);
      },
    };
    return { deps, calls };
  };

  it("rejects a bad secret with 401 and processes nothing", async () => {
    const { deps, calls } = forwardingDeps({ secretOk: false });
    await start(createReceiveCallWebhook(deps as never));
    const res = await post();
    assert.equal(res.status, 401);
    assert.deepEqual(calls, { handle: 0, forward: 0 });
  });

  it("a click-to-call event is acknowledged with 200 and is not forwarded", async () => {
    const { deps, calls } = forwardingDeps({ handled: true });
    await start(createReceiveCallWebhook(deps as never));
    const res = await post();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.deepEqual(calls, { handle: 1, forward: 0 });
  });

  it("any other event is forwarded exactly once and the forwarded handler's response is what CallerDesk receives", async () => {
    const { deps, calls } = forwardingDeps({ handled: false });
    await start(createReceiveCallWebhook(deps as never));
    const res = await post();
    assert.deepEqual(await res.json(), { forwarded: true });
    assert.deepEqual(calls, { handle: 1, forward: 1 });
  });

  it("an error in the click-to-call handler is still acknowledged with 200 (never makes CallerDesk retry)", async () => {
    const { deps } = forwardingDeps({ handled: "throw" });
    await start(createReceiveCallWebhook(deps as never));
    const res = await post();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
  });

  it("if the forwarded handler already answered and then throws, no second response is attempted", async () => {
    const { deps } = forwardingDeps({
      handled: false,
      forward: async (_req, res) => {
        res.status(500).json({ success: false });
        throw new Error("after response");
      },
    });
    await start(createReceiveCallWebhook(deps as never));
    const res = await post();
    assert.equal(res.status, 500, "the forwarded handler's own status stands");
  });
});

describe("shared webhook URL: IVR handler response codes", () => {
  const serviceReturning = (result: CallerDeskWebhookResult): CallerDeskWebhookService => ({ processWebhook: async () => result });
  const reply = async (result: CallerDeskWebhookResult, acknowledgeInvalidPayload: boolean) => {
    await start(createCallerDeskWebhookHandler(() => serviceReturning(result), { acknowledgeInvalidPayload }));
    return post();
  };

  it("an unusable payload is acknowledged with 200 on the shared URL, so CallerDesk has nothing to retry", async () => {
    const res = await reply({ outcome: "INVALID", reason: "invalid or missing fields: callsid" }, true);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean; message: string };
    assert.equal(body.success, true);
    assert.equal(JSON.stringify(body).includes("callsid"), false, "no internal detail echoed");
  });

  it("a genuine processing failure is still 500, so CallerDesk can retry (the event is persisted and retry-safe)", async () => {
    assert.equal((await reply({ outcome: "FAILED" }, true)).status, 500);
  });

  it("processed, duplicate, ignored and unmatched events are all 200", async () => {
    for (const result of [
      { outcome: "DUPLICATE", webhookEventId: "e" },
      { outcome: "IGNORED", webhookEventId: "e", reason: "r" },
      { outcome: "UNMATCHED", webhookEventId: "e", reason: "NO_LEAD_MATCH" },
    ] as CallerDeskWebhookResult[]) {
      assert.equal((await reply(result, true)).status, 200, result.outcome);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("the dedicated /api/webhooks/callerdesk handler is unchanged: an invalid payload is still 400", async () => {
    assert.equal((await reply({ outcome: "INVALID", reason: "x" }, false)).status, 400);
  });

  it("the shared-URL controller really is wired to the acknowledging handler", () => {
    const source = readFileSync(new URL("./calling.controller.ts", import.meta.url), "utf8");
    assert.match(source, /forward: handleSharedUrlCallerDeskWebhook/);
    const handler = readFileSync(new URL("../webhooks/callerdesk/callerdesk.controller.ts", import.meta.url), "utf8");
    assert.match(handler, /handleSharedUrlCallerDeskWebhook = createCallerDeskWebhookHandler\(getService, \{ acknowledgeInvalidPayload: true \}\)/);
  });
});

describe("click-to-call webhook logging", () => {
  const payload = {
    type: "call_report",
    Status: "ANSWER",
    Direction: "Outgoing",
    SourceNumber: "09000000021",
    DestinationNumber: "09000000022",
    DialWhomNumber: "09000000023",
    CallDuration: "55",
    TalkDuration: "40",
    EndTime: "2026-10-16 17:32:10",
    CallSid: "1792152060.2184932",
    CallRecordingUrl: "https://recordings.example.invalid/secret/abc.mp3",
  };

  it("logs a status summary and no phone number, recording URL or CallSid", () => {
    const line = summarizeWebhookForLog("call-1", payload);
    assert.match(line, /call=call-1 type=call_report status=ANSWER direction=Outgoing callDuration=55 talkDuration=40 hasRecording=true hasEndTime=true/);
    for (const forbidden of ["0900000002", "https://", "recordings.example", "1792152060"]) assert.equal(line.includes(forbidden), false, forbidden);
  });

  it("is safe when fields are missing or hostile", () => {
    const line = summarizeWebhookForLog("c", { Status: "ANSWER\nFAKE LOG LINE=1", type: undefined } as never);
    assert.equal(line.includes("\n"), false);
    assert.match(line, /type=none/);
    assert.match(line, /hasRecording=false hasEndTime=false/);
  });

  it("the service no longer logs the raw payload anywhere", () => {
    const source = readFileSync(new URL("./calling.service.ts", import.meta.url), "utf8");
    assert.equal(/logger\.\w+\([^)]*JSON\.stringify\(payload\)/.test(source), false);
    assert.ok(source.includes("summarizeWebhookForLog(call.id, payload)"));
  });
});
