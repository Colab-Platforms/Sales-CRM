import test from "node:test";
import assert from "node:assert/strict";
import { checkDatabase, createCachedDatabaseCheck } from "./dbHealth.js";
import { classifyDatabaseError } from "../utils/databaseErrors.js";

const fake = (impl: () => Promise<unknown>) => ({ $queryRaw: (_q: TemplateStringsArray) => impl() });

test("reachable database -> ok with a round-trip time", async () => {
  const h = await checkDatabase(fake(async () => [{ "?column?": 1 }]));
  assert.equal(h.ok, true);
  assert.equal(h.reason, undefined);
  assert.ok(h.ms >= 0);
});

test("quota error -> not ok, reason 'quota', and nothing of the raw error is exposed", async () => {
  const h = await checkDatabase(fake(async () => { throw Object.assign(new Error("Your account or project has exceeded the quota. postgres://user:secret@host/db"), { code: "53000" }); }));
  assert.deepEqual({ ok: h.ok, reason: h.reason }, { ok: false, reason: "quota" });
  assert.ok(!JSON.stringify(h).includes("secret"));
});

test("a database that never answers is cut off at the timeout and reported as 'timeout'", async () => {
  const started = Date.now();
  const h = await checkDatabase(fake(() => new Promise(() => {})), 50);
  assert.equal(h.ok, false);
  assert.equal(h.reason, "timeout");
  assert.ok(Date.now() - started < 1000);
});

test("an unclassified failure is reported as 'unavailable'", async () => {
  const h = await checkDatabase(fake(async () => { throw new Error("weird"); }));
  assert.deepEqual({ ok: h.ok, reason: h.reason }, { ok: false, reason: "unavailable" });
});

test("the pg pool's connect timeout (what a failed Neon wake-up looks like) is classified as a timeout", () => {
  assert.equal(classifyDatabaseError(new Error("timeout exceeded when trying to connect"))?.kind, "timeout");
});

test("cached check: repeated and concurrent calls reach the database once per window, failures are cached too, and it re-checks after the window", async () => {
  let calls = 0;
  let clock = 1_000;
  const db = fake(async () => { calls++; });
  const check = createCachedDatabaseCheck(db, { ttlMs: 30_000, now: () => clock });
  const [a, b] = await Promise.all([check(), check()]);
  assert.equal(calls, 1, "concurrent callers share one query");
  assert.equal(a.cached, false);
  assert.equal(b.cached, false);
  assert.equal((await check()).cached, true);
  clock += 29_000;
  await check();
  assert.equal(calls, 1);
  clock += 2_000;
  assert.equal((await check()).cached, false);
  assert.equal(calls, 2);

  let failing = 0;
  const bad = createCachedDatabaseCheck(fake(async () => { failing++; throw Object.assign(new Error("x"), { code: "53000" }); }), { ttlMs: 30_000, now: () => clock });
  assert.equal((await bad()).reason, "quota");
  assert.equal((await bad()).cached, true);
  assert.equal(failing, 1, "a down database is not hammered");
});
