// The real username/password login, then an authorized request with the token it returned - over HTTP, through the real auth router and middleware.
// AuthService uses the global Prisma client, so the throwaway user has to be COMMITTED (a rolled-back transaction would be invisible to it). That is only
// acceptable on the isolated database, so the suite refuses to run anywhere else, and the user is removed afterwards.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { prisma } from "../../lib/prisma.js";
import { hashPassword } from "../../lib/password.js";
import { Role } from "../../../generated/prisma/enums.js";
import { errorHandler } from "../../middlewares/errorHandler.js";
import { requestId } from "../../middlewares/requestId.js";
import authRoutes from "./auth.routes.js";

const username = `login-flow-${randomUUID()}`;
const password = "correct-horse-battery";
let userId = "";
let server: Server;
let base = "";

before(async () => {
  const rows = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()::text as current_database`;
  if (rows[0]?.current_database !== "crm_iso") throw new Error(`GUARD: this suite commits a throwaway user and only runs on crm_iso (got ${rows[0]?.current_database})`);
  userId = (await prisma.user.create({ data: { name: "Login Flow Test", username, role: Role.SALESPERSON, passwordHash: await hashPassword(password) }, select: { id: true } })).id;
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use("/auth", authRoutes);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("username/password login, then an authorized request", () => {
  it("login returns a token, and that token opens a protected route as the same user", async () => {
    const login = await post("/auth/login", { username, password });
    assert.equal(login.status, 200);
    const { data } = (await login.json()) as { data: { accessToken: string; user: { id: string; username: string } } };
    assert.ok(data.accessToken);
    assert.equal(data.user.id, userId);

    const me = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${data.accessToken}` } });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { data: { username: string } }).data.username, username);
  });

  it("the same protected route without a token, or with a made-up one, is still 401", async () => {
    assert.equal((await fetch(`${base}/auth/me`)).status, 401);
    assert.equal((await fetch(`${base}/auth/me`, { headers: { Authorization: "Bearer not-a-real-token" } })).status, 401);
  });

  it("a wrong password is 401 and returns no token", async () => {
    const res = await post("/auth/login", { username, password: "wrong-password" });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { data: unknown }).data, null);
  });
});
