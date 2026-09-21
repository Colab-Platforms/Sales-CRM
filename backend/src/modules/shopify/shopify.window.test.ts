import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_START_DATE, EMPTY_WINDOW, formatInZone, isRealDay, isValidTimeZone, parseDateSpec, parseUpdatedSince, resolveWindow, startFloor,
  startOfDay, WindowError, windowSearch,
} from "./shopify.window.js";

const IST = "Asia/Kolkata";
const NOW = new Date("2026-09-19T11:00:00Z");

describe("calendar days in the store's time zone", () => {
  it("starts 1 January at midnight IST, which is 18:30 UTC the day before", () => {
    assert.equal(startOfDay("2026-01-01", IST).toISOString(), "2025-12-31T18:30:00.000Z");
    assert.equal(startOfDay("2026-01-01", "UTC").toISOString(), "2026-01-01T00:00:00.000Z");
  });

  it("includes an order placed just after midnight IST that UTC-based dates would have dropped", () => {
    const order = new Date("2025-12-31T19:46:18Z"); // 01:16 on 1 January in India
    assert.ok(order >= startOfDay("2026-01-01", IST));
    assert.ok(order < startOfDay("2026-01-01", "UTC"));
  });

  it("follows daylight-saving changes", () => {
    assert.equal(startOfDay("2026-01-15", "America/New_York").toISOString(), "2026-01-15T05:00:00.000Z");
    assert.equal(startOfDay("2026-07-15", "America/New_York").toISOString(), "2026-07-15T04:00:00.000Z");
    assert.equal(startOfDay("2026-03-08", "America/New_York").toISOString(), "2026-03-08T05:00:00.000Z"); // the change happens later that day
  });

  it("formats an instant as store-local wall time", () => {
    assert.equal(formatInZone(new Date("2025-12-31T18:30:00Z"), IST), "2026-01-01 00:00");
  });

  it("recognises real and impossible dates and zones", () => {
    assert.equal(isRealDay("2026-02-28"), true);
    assert.equal(isRealDay("2026-02-29"), false);
    assert.equal(isRealDay("2026-1-1"), false);
    assert.equal(isValidTimeZone(IST), true);
    assert.equal(isValidTimeZone("Mars/Olympus"), false);
  });
});

describe("parsing what the operator types", () => {
  it("accepts a day, or a date-time that names its zone", () => {
    assert.deepEqual(parseDateSpec("2026-01-01", "--since"), { kind: "day", ymd: "2026-01-01" });
    assert.deepEqual(parseDateSpec("2026-01-01T00:00:00+05:30", "--since"), { kind: "instant", at: new Date("2025-12-31T18:30:00Z") });
    assert.deepEqual(parseDateSpec("2026-01-01T00:00Z", "--since"), { kind: "instant", at: new Date("2026-01-01T00:00:00Z") });
  });

  it("refuses ambiguous or impossible values, naming the flag", () => {
    for (const bad of ["yesterday", "2026-02-30", "2026-01-01T00:00:00", "01/01/2026", "", "2026"]) {
      assert.throws(() => parseDateSpec(bad, "--since"), (error: unknown) => error instanceof WindowError && /--since/.test(error.message), bad);
    }
  });

  it("reads relative --updated-since values against the given clock", () => {
    assert.deepEqual(parseUpdatedSince("6h", NOW), { kind: "instant", at: new Date("2026-09-19T05:00:00Z") });
    assert.deepEqual(parseUpdatedSince("2d", NOW), { kind: "instant", at: new Date("2026-09-17T11:00:00Z") });
    assert.deepEqual(parseUpdatedSince("2026-09-01", NOW), { kind: "day", ymd: "2026-09-01" });
    assert.throws(() => parseUpdatedSince("0d", NOW), WindowError);
    assert.throws(() => parseUpdatedSince("1w", NOW), WindowError);
  });
});

describe("resolving a window", () => {
  it("defaults to the start date through now, so 2026-01-01 -> execution time", () => {
    const w = resolveWindow(EMPTY_WINDOW, DEFAULT_START_DATE, IST, NOW);
    assert.equal(DEFAULT_START_DATE, "2026-01-01");
    assert.equal(w.createdFrom.toISOString(), "2025-12-31T18:30:00.000Z");
    assert.equal(w.createdTo.toISOString(), NOW.toISOString());
    assert.equal(w.updatedSince, null);
    assert.equal(w.timeZone, IST);
  });

  it("uses the configured start date instead of the built-in one", () => {
    assert.equal(resolveWindow(EMPTY_WINDOW, "2026-04-01", IST, NOW).createdFrom.toISOString(), "2026-03-31T18:30:00.000Z");
  });

  it("--since overrides the start date, and --until includes that whole day", () => {
    const w = resolveWindow(
      { from: { kind: "day", ymd: "2026-02-01" }, to: { kind: "day", ymd: "2026-02-28" }, updatedSince: null },
      DEFAULT_START_DATE, IST, NOW,
    );
    assert.equal(w.createdFrom.toISOString(), "2026-01-31T18:30:00.000Z");
    assert.equal(w.createdTo.toISOString(), "2026-02-28T18:30:00.000Z", "exclusive end = start of 1 March IST");
  });

  it("never reaches past now, so a long run has a fixed upper edge", () => {
    const w = resolveWindow({ from: null, to: { kind: "day", ymd: "2027-01-01" }, updatedSince: null }, DEFAULT_START_DATE, IST, NOW);
    assert.equal(w.createdTo.toISOString(), NOW.toISOString());
  });

  it("rejects a window that is empty or backwards", () => {
    assert.throws(() => resolveWindow({ from: { kind: "day", ymd: "2026-06-01" }, to: { kind: "day", ymd: "2026-05-01" }, updatedSince: null }, DEFAULT_START_DATE, IST, NOW), /window is empty/);
    assert.throws(() => resolveWindow({ from: { kind: "day", ymd: "2026-12-01" }, to: null, updatedSince: null }, DEFAULT_START_DATE, IST, NOW), /window is empty/);
  });

  it("the webhook floor is the start of the configured day", () => {
    assert.equal(startFloor("2026-01-01", IST).toISOString(), "2025-12-31T18:30:00.000Z");
  });
});

describe("Shopify search text", () => {
  it("bounds creation time on both sides, in UTC", () => {
    const w = resolveWindow(EMPTY_WINDOW, DEFAULT_START_DATE, IST, NOW);
    assert.equal(windowSearch(w), "created_at:>='2025-12-31T18:30:00.000Z' created_at:<'2026-09-19T11:00:00.000Z'");
  });

  it("adds updated_at for an incremental run, keeping the created bounds", () => {
    const w = resolveWindow({ ...EMPTY_WINDOW, updatedSince: parseUpdatedSince("24h", NOW) }, DEFAULT_START_DATE, IST, NOW);
    assert.equal(
      windowSearch(w),
      "created_at:>='2025-12-31T18:30:00.000Z' created_at:<'2026-09-19T11:00:00.000Z' updated_at:>='2026-09-18T11:00:00.000Z'",
    );
  });
});
