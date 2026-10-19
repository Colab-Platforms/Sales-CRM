// Auth stays strict (no token / bad token -> 401, valid token -> handler runs) and a rejected request leaves one safe log line
// naming method, route, status and a correlation id - never the token, cookie or query string. No database is involved.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Role } from "../../generated/prisma/enums.js";

process.env.JWT_SECRET ||= "throwaway-test-secret";
const { signToken } = await import("../lib/jwt.js");
const { requireAuth } = await import("./auth.js");
const { errorHandler } = await import("./errorHandler.js");
const { requestId } = await import("./requestId.js");

async function call(path: string, headers: Record<string, string> = {}) {
  const app = express();
  app.use(requestId);
  app.get("/protected", requireAuth, (_req, res) => { res.json({ ok: true }); });
  app.use(errorHandler);
  const server = app.listen(0);
  const warnings: string[] = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  console.error = () => {};
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: res.status, requestId: res.headers.get("x-request-id"), warnings };
  } finally {
    console.warn = realWarn;
    console.error = realError;
    server.close();
  }
}

describe("requireAuth + auth-failure logging", () => {
  it("a valid token reaches the handler", async () => {
    const token = signToken({ sub: "00000000-0000-4000-8000-000000000001", role: Role.ADMIN, username: "t" });
    const r = await call("/protected", { Authorization: `Bearer ${token}` });
    assert.equal(r.status, 200);
    assert.equal(r.warnings.length, 0);
  });

  it("no Authorization header stays 401 and is logged with method, route, status, authHeader=false and the correlation id", async () => {
    const r = await call("/protected?secret=abc");
    assert.equal(r.status, 401);
    assert.ok(r.requestId);
    assert.equal(r.warnings.length, 1);
    const line = r.warnings[0];
    assert.match(line, /\[auth\] 401 GET \/protected reason="Authentication required" authHeader=false/);
    assert.ok(line.includes(`requestId=${r.requestId}`));
    assert.ok(!line.includes("secret=abc"), "query string must not be logged");
  });

  it("a bad token stays 401, is logged as authHeader=true, and the token itself is never logged", async () => {
    const r = await call("/protected", { Authorization: "Bearer not-a-real-token-value" });
    assert.equal(r.status, 401);
    assert.match(r.warnings[0], /reason="Invalid or expired token" authHeader=true/);
    assert.ok(!r.warnings[0].includes("not-a-real-token-value"));
  });

  it("an inbound X-Request-Id is kept when plain and replaced when it is not", async () => {
    assert.equal((await call("/protected", { "X-Request-Id": "abc-123" })).requestId, "abc-123");
    const replaced = (await call("/protected", { "X-Request-Id": "bad id with spaces\t" })).requestId;
    assert.ok(replaced && replaced !== "bad id with spaces\t");
  });
});
