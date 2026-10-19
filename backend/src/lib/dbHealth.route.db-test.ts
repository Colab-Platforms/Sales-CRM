// GET /api/health and GET /api/health/db through the REAL router, over HTTP, against the ISOLATED test database only. Read-only (SELECT 1); tokens are signed locally.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { signToken } from "./jwt.js";
import { prisma } from "./prisma.js";
import routes from "../routes.js";
import { errorHandler } from "../middlewares/errorHandler.js";

if (!/127\.0\.0\.1:5544\/crm_iso$/.test(process.env.DATABASE_URL ?? "")) throw new Error("GUARD: this test only runs against the isolated database");

let server: Server;
let base = "";
const token = (role: string) => signToken({ sub: "00000000-0000-0000-0000-000000000001", role, username: `t-${role}` } as never);
const get = (path: string, bearer?: string) => fetch(`${base}${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

before(async () => {
  const app = express();
  app.use("/api", routes);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

describe("health endpoints", () => {
  it("/health stays a plain liveness check (no auth, no database)", async () => {
    const res = await get("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, message: "ok" });
  });

  it("/health/db rejects a caller with no token (401) and a non-admin (403) - before any database work", async () => {
    assert.equal((await get("/health/db")).status, 401);
    for (const role of ["SALESPERSON", "MANAGER", "HR"]) assert.equal((await get("/health/db", token(role))).status, 403, role);
  });

  it("/health/db for an admin reaches the database: 200, a round trip, no-store, and nothing but those fields", async () => {
    const res = await get("/health/db", token("ADMIN"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.deepEqual(Object.keys(body.data).sort(), ["cached", "ms", "ok"]);
    assert.equal(body.data.ok, true);
    const raw = JSON.stringify(body);
    for (const leak of ["postgres", "5544", "crm_iso", "localhost", "password"]) assert.ok(!raw.includes(leak), `leaked: ${leak}`);
  });

  it("a second admin call inside the window is served from the cache", async () => {
    const body = (await (await get("/health/db", token("ADMIN"))).json()) as any;
    assert.equal(body.data.cached, true);
  });
});
