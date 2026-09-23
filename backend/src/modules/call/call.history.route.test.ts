// Must be the first import: lib/jwt reads JWT_SECRET when it is first loaded.
import "./call.test-env.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import express from "express";
import { CallDirection, CallStatus, Role } from "@root/generated/prisma/enums.js";
import { signToken } from "@/lib/jwt.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { errorHandler } from "@/middlewares/errorHandler.js";
import { createGetCallHandler, createListCallsHandler } from "./call.controller.js";
import { createCallRouter } from "./call.routes.js";
import type { CallHistoryService } from "./call.history.service.js";
import type { CallDetail, CallListResult, ListCallsQuery } from "./call.history.types.js";

const CALL_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

const LIST_ITEM = {
  id: CALL_ID,
  lead: { id: "lead-1", leadNumber: "LEAD-001", firstName: "Rahul", lastName: "Sharma", mobile: "9876543210" },
  agent: { id: "agent-1", name: "E3 UAT Salesperson" },
  direction: CallDirection.OUTBOUND,
  status: CallStatus.COMPLETED,
  startedAt: new Date("2026-01-05T10:00:00.000Z"),
  endedAt: new Date("2026-01-05T10:05:00.000Z"),
  durationSeconds: 300,
  outcome: null,
  hasRecording: false,
  createdAt: new Date("2026-01-05T09:59:00.000Z"),
};

const LIST_RESULT: CallListResult = { data: [LIST_ITEM], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } };
const DETAIL_RESULT: CallDetail = { ...LIST_ITEM, answeredAt: new Date("2026-01-05T10:00:05.000Z"), notes: null, callingIdentity: { displayName: "Avatar Sales", number: "01204567890" } };

let server: Server | undefined;
let baseUrl = "";
let listBehaviour: () => Promise<CallListResult> = async () => LIST_RESULT;
let getBehaviour: () => Promise<CallDetail> = async () => DETAIL_RESULT;
let seenActors: { id: string; role: Role }[] = [];
let seenListQueries: ListCallsQuery[] = [];
let seenCallIds: string[] = [];
let logs: string[] = [];

const fakeHistoryService: Pick<CallHistoryService, "listCalls" | "getCallById"> = {
  async listCalls(actor, query) {
    seenActors.push(actor);
    seenListQueries.push(query);
    return listBehaviour();
  },
  async getCallById(actor, id) {
    seenActors.push(actor);
    seenCallIds.push(id);
    return getBehaviour();
  },
};

const token = (role: Role, id = "user-1") => signToken({ sub: id, role, email: "user@example.test" });

beforeEach(async () => {
  listBehaviour = async () => LIST_RESULT;
  getBehaviour = async () => DETAIL_RESULT;
  seenActors = [];
  seenListQueries = [];
  seenCallIds = [];
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);

  const app = express();
  app.use(express.json());
  app.use(
    "/api/calls",
    createCallRouter(
      undefined,
      createListCallsHandler(() => fakeHistoryService as CallHistoryService),
      createGetCallHandler(() => fakeHistoryService as CallHistoryService),
    ),
  );
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

const get = (path: string, authorization?: string) =>
  fetch(`${baseUrl}${path}`, { headers: authorization ? { Authorization: authorization } : {} });

describe("GET /api/calls - authentication and roles", () => {
  it("requires a CRM user: no token and a bad token are both 401, service never called", async () => {
    assert.equal((await get("")).status, 401);
    assert.equal((await get("", "Bearer not-a-jwt")).status, 401);
    assert.equal(seenActors.length, 0);
  });

  it("allows ADMIN, MANAGER and SALESPERSON, passing the token's identity through", async () => {
    for (const role of [Role.ADMIN, Role.MANAGER, Role.SALESPERSON]) {
      const res = await get("", `Bearer ${token(role, `id-${role}`)}`);
      assert.equal(res.status, 200, role);
    }
    assert.deepEqual(
      seenActors.map((a) => a.role),
      [Role.ADMIN, Role.MANAGER, Role.SALESPERSON],
    );
  });

  it("rejects an unknown role with 403, and the service is never called", async () => {
    const res = await get("", `Bearer ${token("HACKER" as Role)}`);
    assert.equal(res.status, 403);
    assert.equal(seenActors.length, 0);
  });
});

describe("GET /api/calls - query handling", () => {
  const auth = () => `Bearer ${token(Role.SALESPERSON)}`;

  it("defaults page/limit and forwards every real filter to the service", async () => {
    await get("?page=2&limit=10&search=Sharma&status=COMPLETED&direction=OUTBOUND&dateFrom=2026-01-01&dateTo=2026-01-31", auth());
    assert.equal(seenListQueries.length, 1);
    const q = seenListQueries[0]!;
    assert.equal(q.page, 2);
    assert.equal(q.limit, 10);
    assert.equal(q.search, "Sharma");
    assert.equal(q.status, "COMPLETED");
    assert.equal(q.direction, "OUTBOUND");
    assert.equal(q.dateFrom?.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(q.dateTo?.toISOString(), "2026-01-31T23:59:59.999Z");
  });

  it("defaults to page 1, limit 20 with no query at all", async () => {
    await get("", auth());
    assert.deepEqual(seenListQueries[0], { page: 1, limit: 20 });
  });

  it("400s an invalid status/direction/limit without calling the service", async () => {
    for (const query of ["?status=NOT_A_STATUS", "?direction=SIDEWAYS", "?limit=0", "?limit=101", "?dateFrom=not-a-date"]) {
      const res = await get(query, auth());
      const body = (await res.json()) as { success: boolean };
      assert.equal(res.status, 400, query);
      assert.equal(body.success, false);
    }
    assert.equal(seenListQueries.length, 0);
  });

  it("200 with the exact result the service returned, and the response has no provider names in it", async () => {
    const res = await get("", auth());
    const body = (await res.json()) as { success: boolean; data: CallListResult };
    assert.equal(res.status, 200);
    assert.deepEqual(body.data.data[0]!.id, CALL_ID);
    assert.deepEqual(body.data.pagination, { page: 1, limit: 20, total: 1, totalPages: 1 });
    assert.ok(!/callerdesk|exotel/i.test(JSON.stringify(body)));
  });

  it("newest-first ordering and pagination are the service's own concern, not re-sorted or re-paginated here", async () => {
    const older = { ...LIST_ITEM, id: "aaaaaaaa-0000-4000-8000-000000000000", createdAt: new Date("2026-01-01T00:00:00.000Z") };
    const newer = { ...LIST_ITEM, id: "bbbbbbbb-0000-4000-8000-000000000000", createdAt: new Date("2026-01-06T00:00:00.000Z") };
    listBehaviour = async () => ({ data: [newer, older], pagination: { page: 1, limit: 20, total: 2, totalPages: 1 } });
    const res = await get("", auth());
    const body = (await res.json()) as { data: CallListResult };
    assert.deepEqual(body.data.data.map((c) => c.id), [newer.id, older.id]);
  });

  it("an unexpected error becomes a generic 500 - no message or stack leaks", async () => {
    listBehaviour = async () => {
      throw new Error("connection to FAKE-LEAK-CANARY failed");
    };
    const res = await get("", auth());
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(text), { success: false, message: "Something went wrong", data: null });
    assert.ok(!text.includes("FAKE-LEAK-CANARY"));
    assert.ok(!logs.join("\n").includes("FAKE-LEAK-CANARY"));
  });
});

describe("GET /api/calls/:id", () => {
  const auth = () => `Bearer ${token(Role.SALESPERSON)}`;

  it("200 with the full detail shape, matching the frontend's CallDetail contract", async () => {
    const res = await get(`/${CALL_ID}`, auth());
    const body = (await res.json()) as { success: boolean; data: CallDetail };
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(body.data).sort(), Object.keys(DETAIL_RESULT).sort());
    assert.deepEqual(body.data.callingIdentity, { displayName: "Avatar Sales", number: "01204567890" });
    assert.equal(seenCallIds[0], CALL_ID);
  });

  it("400 for a non-uuid id, service never called", async () => {
    const res = await get("/not-a-uuid", auth());
    assert.equal(res.status, 400);
    assert.equal(seenCallIds.length, 0);
  });

  it("404 when the service reports the call as not found (missing OR out of the caller's scope)", async () => {
    getBehaviour = async () => {
      throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);
    };
    const res = await get(`/${CALL_ID}`, auth());
    const body = (await res.json()) as { success: boolean; message: string; data: unknown };
    assert.equal(res.status, 404);
    assert.equal(body.success, false);
    assert.equal(body.message, "Call not found");
    assert.equal(body.data, null);
  });

  it("an unexpected error becomes a generic 500 - no message or stack leaks", async () => {
    getBehaviour = async () => {
      throw new Error("connection to FAKE-LEAK-CANARY failed");
    };
    const res = await get(`/${CALL_ID}`, auth());
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.ok(!text.includes("FAKE-LEAK-CANARY"));
    assert.ok(!logs.join("\n").includes("FAKE-LEAK-CANARY"));
  });

  it("never contains a provider name", async () => {
    const res = await get(`/${CALL_ID}`, auth());
    const text = await res.text();
    assert.ok(!/callerdesk|exotel/i.test(text));
  });
});
