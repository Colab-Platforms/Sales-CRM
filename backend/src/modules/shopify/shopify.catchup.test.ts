import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { catchUpOptions, createCatchUp, loadCatchUpConfig } from "./shopify.catchup.js";
import type { SyncReport } from "./shopify.sync.js";

const report = (error: Error | null = null) => ({ error, counts: { orders: { created: 1, updated: 0, skipped: 0, failed: 0 } } }) as unknown as SyncReport;

describe("Shopify catch-up configuration", () => {
  it("is off unless SHOPIFY_SYNC_ENABLED=true (the existing Shopify -> CRM switch)", () => {
    assert.equal(loadCatchUpConfig({}), null);
    assert.equal(loadCatchUpConfig({ SHOPIFY_SYNC_ENABLED: "false" }), null);
    assert.equal(loadCatchUpConfig({ SHOPIFY_SYNC_ENABLED: "yes" }), null);
  });
  it("defaults to every 15 minutes with a 24 hour look-back once sync is on", () => {
    assert.deepEqual(loadCatchUpConfig({ SHOPIFY_SYNC_ENABLED: "true" }), { intervalMinutes: 15, lookbackHours: 24 });
    assert.deepEqual(loadCatchUpConfig({ SHOPIFY_SYNC_ENABLED: " TRUE " }), { intervalMinutes: 15, lookbackHours: 24 });
  });
  it("0 minutes switches only the timer off; bad numbers fall back to the defaults; the look-back is bounded", () => {
    assert.equal(loadCatchUpConfig({ SHOPIFY_SYNC_ENABLED: "true", SHOPIFY_SYNC_POLL_MINUTES: "0" }), null);
    assert.deepEqual(loadCatchUpConfig({ SHOPIFY_SYNC_ENABLED: "true", SHOPIFY_SYNC_POLL_MINUTES: "abc", SHOPIFY_SYNC_POLL_LOOKBACK_HOURS: "-3" }), { intervalMinutes: 15, lookbackHours: 24 });
    assert.deepEqual(loadCatchUpConfig({ SHOPIFY_SYNC_ENABLED: "true", SHOPIFY_SYNC_POLL_MINUTES: "5", SHOPIFY_SYNC_POLL_LOOKBACK_HOURS: "48" }), { intervalMinutes: 5, lookbackHours: 48 });
    assert.equal(loadCatchUpConfig({ SHOPIFY_SYNC_ENABLED: "true", SHOPIFY_SYNC_POLL_LOOKBACK_HOURS: "99999" })!.lookbackHours, 24 * 14);
  });
});

describe("one catch-up run", () => {
  it("reads only orders changed within the look-back, never forced, never a dry run", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    const o = catchUpOptions({ intervalMinutes: 15, lookbackHours: 24 }, now);
    assert.deepEqual(o.only, ["orders"]);
    assert.equal(o.force, false);
    assert.equal(o.dryRun, false);
    assert.equal(o.limit, null);
    assert.deepEqual(o.window.updatedSince, { kind: "instant", at: new Date("2026-10-07T12:00:00Z") });
  });
  it("reports success and failure without ever throwing, and never overlaps itself", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const c = createCatchUp({
      config: { intervalMinutes: 15, lookbackHours: 24 },
      run: async () => { calls++; await gate; return report(); },
      onResult: () => seen.push("ok"),
      onError: () => seen.push("err"),
    });
    const first = c.tick();
    assert.equal(await c.tick(), false, "a second tick while one is running is skipped");
    release();
    assert.equal(await first, true);
    assert.deepEqual([calls, seen], [1, ["ok"]]);

    const failing = createCatchUp({ config: { intervalMinutes: 15, lookbackHours: 24 }, run: async () => { throw new Error("boom"); }, onError: () => seen.push("thrown") });
    assert.equal(await failing.tick(), true);
    const reported = createCatchUp({ config: { intervalMinutes: 15, lookbackHours: 24 }, run: async () => report(new Error("scope")), onError: () => seen.push("reported") });
    await reported.tick();
    assert.deepEqual(seen, ["ok", "thrown", "reported"]);
    assert.equal(await failing.tick(), true, "the next pass still runs after a failure");
  });
});
