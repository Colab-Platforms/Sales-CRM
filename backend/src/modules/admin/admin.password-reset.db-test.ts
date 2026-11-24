// Password reset for every account type, over HTTP through the real admin + auth routers and middleware: who may reset whose password, that the new password then logs in and the old one no longer does,
// that a caller without the right role is refused (403) and leaves the password untouched, that an id of the wrong account type is "not found", and the validation rules.
// AdminService uses the global Prisma client, so the throwaway users are COMMITTED: the suite refuses to run anywhere but the isolated database crm_iso, and removes them afterwards.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { prisma } from "../../lib/prisma.js";
import { comparePassword, hashPassword } from "../../lib/password.js";
import { signToken } from "../../lib/jwt.js";
import { Role } from "../../../generated/prisma/enums.js";
import { errorHandler } from "../../middlewares/errorHandler.js";
import { requestId } from "../../middlewares/requestId.js";
import authRoutes from "../auth/auth.routes.js";
import adminRoutes from "./admin.routes.js";

const OLD = "old-password-1";
const NEW = "new-password-2";
const tag = randomUUID().slice(0, 8);
type Kind = "ADMIN" | "HR" | "MANAGER" | "SALESPERSON" | "RECRUITER";
const KINDS: Kind[] = ["ADMIN", "HR", "MANAGER", "SALESPERSON", "RECRUITER"];
const ROUTE: Record<Kind, string> = { ADMIN: "admins", HR: "hr", MANAGER: "managers", SALESPERSON: "salespersons", RECRUITER: "recruiters" };
// who may reset the password of each account type (the permission pattern of admin.routes.ts)
const ALLOWED: Record<Kind, Kind[]> = { ADMIN: ["ADMIN"], HR: ["ADMIN"], MANAGER: ["ADMIN"], SALESPERSON: ["ADMIN", "HR"], RECRUITER: ["ADMIN", "HR"] };
const CALLERS: Kind[] = ["ADMIN", "HR", "MANAGER", "SALESPERSON"];

const users = new Map<string, { id: string; username: string }>(); // key `${kind}:${label}`
let server: Server;
let base = "";

async function make(kind: Kind, label: string) {
  const username = `pw-${tag}-${kind.toLowerCase()}-${label}`;
  const u = await prisma.user.create({ data: { name: `PW ${kind} ${label}`, username, role: Role[kind], passwordHash: await hashPassword(OLD) }, select: { id: true } });
  users.set(`${kind}:${label}`, { id: u.id, username });
  return users.get(`${kind}:${label}`)!;
}
const tokenOf = (kind: Kind) => {
  const u = users.get(`${kind}:caller`)!;
  return signToken({ sub: u.id, role: Role[kind], username: u.username } as never);
};
const patch = (kind: Kind, id: string, body: unknown, token?: string) =>
  fetch(`${base}/admin/${ROUTE[kind]}/${id}/password`, { method: "PATCH", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const login = (username: string, password: string) => fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
const hashOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id }, select: { passwordHash: true } })).passwordHash!;

before(async () => {
  const rows = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()::text as current_database`;
  if (rows[0]?.current_database !== "crm_iso") throw new Error(`GUARD: this suite commits throwaway users and only runs on crm_iso (got ${rows[0]?.current_database})`);
  for (const k of CALLERS) await make(k, "caller");
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use("/auth", authRoutes);
  app.use("/admin", adminRoutes);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await prisma.user.deleteMany({ where: { username: { startsWith: `pw-${tag}-` } } });
  await prisma.$disconnect();
});

describe("who may reset which account's password", () => {
  for (const target of KINDS) {
    for (const caller of CALLERS) {
      const allowed = ALLOWED[target].includes(caller);
      it(`${caller} ${allowed ? "CAN" : "CANNOT"} reset a ${target} password`, async () => {
        const t = await make(target, `${caller.toLowerCase()}-tgt`);
        const before = await hashOf(t.id);
        const res = await patch(target, t.id, { password: NEW }, tokenOf(caller));
        if (allowed) {
          assert.equal(res.status, 200);
          const body = (await res.json()) as { data: Record<string, unknown> };
          assert.ok(!("passwordHash" in body.data) && !JSON.stringify(body).includes("$2"), "the response must never carry a hash");
          assert.ok(await comparePassword(NEW, await hashOf(t.id)));
          assert.equal((await login(t.username, NEW)).status, 200, "the new password logs in");
          assert.notEqual((await login(t.username, OLD)).status, 200, "the old password no longer works");
        } else {
          assert.equal(res.status, 403);
          assert.equal(await hashOf(t.id), before, "a refused reset must not change the password");
          assert.equal((await login(t.username, OLD)).status, 200, "the old password still works");
        }
      });
    }
  }
});

describe("authentication, validation and wrong-type ids", () => {
  it("no token is 401 and changes nothing", async () => {
    for (const target of KINDS) {
      const t = await make(target, "noauth");
      const before = await hashOf(t.id);
      assert.equal((await patch(target, t.id, { password: NEW })).status, 401, target);
      assert.equal(await hashOf(t.id), before);
    }
  });
  it("a password shorter than 6 characters, or a missing or empty one is 400", async () => {
    const t = await make("HR", "validation");
    const before = await hashOf(t.id);
    for (const body of [{ password: "12345" }, {}, { password: "" }]) assert.equal((await patch("HR", t.id, body, tokenOf("ADMIN"))).status, 400, JSON.stringify(body));
    assert.equal(await hashOf(t.id), before);
  });
  it("an id of a different account type is 404 and is not touched (the HR/Admin routes cannot reach a manager or salesperson)", async () => {
    for (const route of ["HR", "ADMIN"] as Kind[]) {
      for (const other of KINDS.filter((k) => k !== route)) {
        const t = await make(other, `cross-${route.toLowerCase()}`);
        const before = await hashOf(t.id);
        assert.equal((await patch(route, t.id, { password: NEW }, tokenOf("ADMIN"))).status, 404, `${route} route on a ${other}`);
        assert.equal(await hashOf(t.id), before);
      }
    }
  });
  it("an unknown id is 404", async () => {
    for (const target of KINDS) assert.equal((await patch(target, randomUUID(), { password: NEW }, tokenOf("ADMIN"))).status, 404, target);
  });
  it("an Admin can reset their own password", async () => {
    const me = users.get("ADMIN:caller")!;
    assert.equal((await patch("ADMIN", me.id, { password: NEW }, tokenOf("ADMIN"))).status, 200);
    assert.equal((await login(me.username, NEW)).status, 200);
  });
});
