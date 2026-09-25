// Must be the first import: lib/jwt reads JWT_SECRET when it is first loaded.
import "./call.test-env.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import express from "express";
import { CallStatus, Role } from "@root/generated/prisma/enums.js";
import { signToken } from "@/lib/jwt.js";
import { errorHandler } from "@/middlewares/errorHandler.js";
import type { InitiateCallErrorCode, InitiateCallResponse } from "@modules/telephony/call.contract.js";
import { createInitiateCallHandler } from "./call.controller.js";
import { createCallRouter } from "./call.routes.js";
import { CallInitiationError, type CallService } from "./call.service.js";

const LEAD_ID = "3f1c5b2e-8f0a-4c6e-9a55-0d1f7a4b2c11";
const CALL_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

const SUCCESS: InitiateCallResponse = {
  callId: CALL_ID,
  status: CallStatus.INITIATED,
  callingIdentity: { displayName: "Avatar Sales", number: "01204567890" },
};

let server: Server | undefined;
let baseUrl = "";
let behaviour: () => Promise<InitiateCallResponse> = async () => SUCCESS;
let seenActors: { id: string; role: Role }[] = [];
let seenRequests: unknown[] = [];
let logs: string[] = [];

const fakeService: CallService = {
  async initiateCall(actor, request) {
    seenActors.push(actor);
    seenRequests.push(request);
    return behaviour();
  },
};

const token = (role: Role, id = "user-1") => signToken({ sub: id, role, email: "user@example.test" });

beforeEach(async () => {
  behaviour = async () => SUCCESS;
  seenActors = [];
  seenRequests = [];
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);

  const app = express();
  app.use(express.json());
  app.use("/api/calls", createCallRouter(createInitiateCallHandler(() => fakeService) as never));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/calls`;
});

afterEach(async () => {
  mock.restoreAll();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
});

const post = (body: unknown, authorization?: string) =>
  fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(body),
  });

describe("POST /api/calls - authentication and roles", () => {
  it("requires a CRM user: no token, malformed header and bad token are all 401 and never reach the service", async () => {
    assert.equal((await post({ leadId: LEAD_ID })).status, 401);
    assert.equal((await post({ leadId: LEAD_ID }, "Token abc")).status, 401);
    assert.equal((await post({ leadId: LEAD_ID }, "Bearer not-a-jwt")).status, 401);
    assert.equal(seenActors.length, 0);
  });

  it("allows ADMIN, MANAGER and SALESPERSON and passes the token's identity (not the body's) to the service", async () => {
    for (const role of [Role.ADMIN, Role.MANAGER, Role.SALESPERSON]) {
      const res = await post({ leadId: LEAD_ID, agentId: "attacker-supplied", userId: "attacker-supplied" }, `Bearer ${token(role, `id-${role}`)}`);
      assert.equal(res.status, 201, role);
    }
    assert.deepEqual(seenActors, [
      { id: "id-ADMIN", role: "ADMIN" },
      { id: "id-MANAGER", role: "MANAGER" },
      { id: "id-SALESPERSON", role: "SALESPERSON" },
    ]);
    assert.ok(seenRequests.every((r) => JSON.stringify(r) === JSON.stringify({ leadId: LEAD_ID })), "only leadId is accepted from the body");
  });

  it("rejects an unknown role with 403", async () => {
    const res = await post({ leadId: LEAD_ID }, `Bearer ${token("HACKER" as Role)}`);
    assert.equal(res.status, 403);
    assert.equal(seenActors.length, 0);
  });
});

describe("POST /api/calls - request and response contract", () => {
  const auth = () => `Bearer ${token(Role.SALESPERSON)}`;

  it("201 with the provider-neutral payload", async () => {
    const res = await post({ leadId: LEAD_ID }, auth());
    const body = (await res.json()) as { success: boolean; message: string; data: InitiateCallResponse };

    assert.equal(res.status, 201);
    assert.equal(body.success, true);
    assert.deepEqual(body.data, SUCCESS);
    assert.ok(!/callerdesk|exotel|campid/i.test(JSON.stringify(body)));
  });

  it("400 INVALID_REQUEST for a missing, non-uuid or non-string leadId - the service is not called", async () => {
    for (const bad of [{}, { leadId: "not-a-uuid" }, { leadId: 42 }, { leadId: null }, []]) {
      const res = await post(bad, auth());
      const body = (await res.json()) as { success: boolean; data: { code: string } };
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(body.success, false);
      assert.equal(body.data.code, "INVALID_REQUEST");
    }
    assert.equal(seenActors.length, 0);
  });

  it("a top-level JSON primitive is rejected with 400 by the global body parser before the handler", async () => {
    // Existing server-wide behaviour (express.json strict mode + errorHandler); not this route's code path.
    const res = await post("leadId", auth());
    assert.equal(res.status, 400);
    assert.equal(seenActors.length, 0);
  });

  it("maps every domain error to its documented status and code, with a provider-neutral body", async () => {
    const table: [InitiateCallErrorCode, number][] = [
      ["LEAD_NOT_FOUND", 404],
      ["LEAD_PHONE_MISSING", 422],
      ["AGENT_PHONE_MISSING", 422],
      ["CALLING_IDENTITY_UNAVAILABLE", 422],
      ["CALL_ALREADY_IN_PROGRESS", 409],
      ["TELEPHONY_UNAVAILABLE", 503],
      ["CALL_OUTCOME_UNKNOWN", 502],
    ];
    for (const [code, status] of table) {
      behaviour = async () => {
        throw new CallInitiationError(code, "neutral message", CALL_ID);
      };
      const res = await post({ leadId: LEAD_ID }, auth());
      const body = (await res.json()) as { success: boolean; message: string; data: { code: string; callId?: string } };

      assert.equal(res.status, status, code);
      assert.equal(body.success, false);
      assert.equal(body.data.code, code);
      assert.equal(body.data.callId, CALL_ID);
      assert.equal(body.message, "neutral message");
    }
  });

  it("an unexpected error becomes a generic 500 - no message, stack or error object leaks", async () => {
    behaviour = async () => {
      throw new Error("connection to FAKE-LEAK-CANARY failed");
    };

    const res = await post({ leadId: LEAD_ID }, auth());
    const text = await res.text();

    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(text), { success: false, message: "Something went wrong", data: { code: "INTERNAL_ERROR" } });
    assert.ok(!text.includes("FAKE-LEAK-CANARY") && !/stack|postgres/i.test(text));
    assert.ok(!logs.join("\n").includes("FAKE-LEAK-CANARY"), "raw error text is not logged either");
  });
});
