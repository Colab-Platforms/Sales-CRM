// Editable usernames: validation rules and who may call the update endpoints. No database (denied roles are refused before any handler runs).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Role } from "../../../generated/prisma/enums.js";
import { validateUpdateManagerSchema, validateUpdateSalespersonSchema } from "./admin.validators.js";

process.env.JWT_SECRET ||= "throwaway-test-secret";
const { signToken } = await import("../../lib/jwt.js");
const { default: router } = await import("./admin.routes.js");

describe("update username: validation (same rules as account creation)", () => {
  it("is trimmed and lower-cased, like login", () => {
    const r = validateUpdateManagerSchema({ username: "  Sanjay.Bhati_2 " });
    assert.ok(!r.error);
    assert.equal(r.value?.username, "sanjay.bhati_2");
  });
  it("invalid usernames are rejected with a clear message (too short, too long, spaces, symbols, empty)", () => {
    for (const bad of ["ab", "a".repeat(51), "has space", "semi;colon", "émile", "", "   "]) {
      const r = validateUpdateSalespersonSchema({ username: bad });
      assert.ok(r.error, `"${bad}" should be rejected`);
    }
    assert.match(String(validateUpdateManagerSchema({ username: "ab" }).error?.message), /at least 3/);
    assert.match(String(validateUpdateManagerSchema({ username: "a b" }).error?.message), /letters, numbers, dots, underscores and hyphens/i);
  });
  it("username is optional: the name/phone-only edits still validate, and an empty body is still refused", () => {
    assert.ok(!validateUpdateManagerSchema({ name: "Sanjay Singh" }).error);
    assert.ok(validateUpdateManagerSchema({}).error);
  });
});

async function patch(path: string, role?: Role): Promise<number> {
  const app = express();
  app.use(express.json());
  app.use("/admin", router);
  app.use((err: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.statusCode ?? 500).json({ ok: false }); });
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(role ? { Authorization: `Bearer ${signToken({ sub: "00000000-0000-4000-8000-000000000001", role, username: "t" } as never)}` } : {}) };
    return (await fetch(`http://127.0.0.1:${port}${path}`, { method: "PATCH", headers, body: JSON.stringify({ username: "new.name" }) })).status;
  } finally {
    server.close();
  }
}

describe("update username: authorization is enforced by the backend", () => {
  const manager = "/admin/managers/00000000-0000-4000-8000-0000000000aa";
  it("no token -> 401; a manager, salesperson, recruiter or HR may NOT change a manager's username (admin only)", async () => {
    assert.equal(await patch(manager), 401);
    for (const role of [Role.MANAGER, Role.SALESPERSON, Role.RECRUITER, Role.HR]) assert.equal(await patch(manager, role), 403, role);
  });
  it("salesperson accounts: no token -> 401; manager / salesperson / recruiter -> 403 (admin and HR keep their existing right to edit them)", async () => {
    const sp = "/admin/salespersons/00000000-0000-4000-8000-0000000000bb";
    assert.equal(await patch(sp), 401);
    for (const role of [Role.MANAGER, Role.SALESPERSON, Role.RECRUITER]) assert.equal(await patch(sp, role), 403, role);
  });
});
