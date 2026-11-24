import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { buildInfo } from "./buildInfo.js";

process.env.JWT_SECRET ||= "throwaway-test-secret";
const { default: routes } = await import("../routes.js");

describe("buildInfo", () => {
  it("returns the Render commit and production when both are set", () => {
    assert.deepEqual(buildInfo({ RENDER_GIT_COMMIT: "bd136db4f1c2a9e0d3b5a7c8e9f01234567890ab", NODE_ENV: "production" }), { gitCommit: "bd136db4f1c2a9e0d3b5a7c8e9f01234567890ab", environment: "production" });
  });
  it("returns null (not an error) when the commit is missing, as it is locally", () => {
    assert.deepEqual(buildInfo({}), { gitCommit: null, environment: "development" });
    assert.equal(buildInfo({ RENDER_GIT_COMMIT: "   " }).gitCommit, null);
  });
  it("accepts only a plain commit hash: anything else in the variable is dropped, never echoed", () => {
    for (const odd of ["not-a-hash", "bd136db; DROP TABLE", "postgres://user:pass@host/db", "abc", "g".repeat(40), "a".repeat(41)]) assert.equal(buildInfo({ RENDER_GIT_COMMIT: odd }).gitCommit, null, odd);
    assert.equal(buildInfo({ RENDER_GIT_COMMIT: "  BD136DB  " }).gitCommit, "bd136db", "trimmed and lower-cased");
  });
  it("environment is production only for NODE_ENV=production", () => {
    assert.equal(buildInfo({ NODE_ENV: "production" }).environment, "production");
    for (const e of [undefined, "development", "test", "staging"]) assert.equal(buildInfo({ NODE_ENV: e }).environment, "development");
  });
  it("exposes nothing else: exactly two fields", () => {
    assert.deepEqual(Object.keys(buildInfo({ RENDER_GIT_COMMIT: "bd136db", DATABASE_URL: "postgres://secret", JWT_SECRET: "x", NODE_ENV: "production" })).sort(), ["environment", "gitCommit"]);
  });
});

describe("GET /health on the real router (no login)", () => {
  let server: Server;
  let base = "";
  const saved = { commit: process.env.RENDER_GIT_COMMIT, env: process.env.NODE_ENV };
  before(async () => {
    const app = express();
    app.use("/api", routes);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  after(() => {
    server?.close();
    if (saved.commit === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = saved.commit;
    if (saved.env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.env;
  });

  it("Render commit present: it is in the answer, and the original fields are unchanged", async () => {
    process.env.RENDER_GIT_COMMIT = "bd136db4f1c2a9e0d3b5a7c8e9f01234567890ab";
    process.env.NODE_ENV = "production";
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, message: "ok", gitCommit: "bd136db4f1c2a9e0d3b5a7c8e9f01234567890ab", environment: "production" });
  });
  it("commit missing (local): null, still 200, still the original fields", async () => {
    delete process.env.RENDER_GIT_COMMIT;
    delete process.env.NODE_ENV;
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, { success: true, message: "ok", gitCommit: null, environment: "development" });
  });
  it("needs no login, and the old reader still works (it only looks at success and message)", async () => {
    const res = await fetch(`${base}/health`);
    const body = (await res.json()) as { success: boolean; message: string };
    assert.equal(res.status, 200);
    assert.deepEqual([body.success, body.message], [true, "ok"]);
    assert.ok(!JSON.stringify(body).match(/postgres|DATABASE|SECRET|password/i), "nothing sensitive in the response");
  });
});
