// Pure tests: the Today / Yesterday / All day ranges of the abandoned-leads queue (reporting timezone IST = UTC+05:30, half-open [gte, lt)).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { abandonmentDateRangeBounds } from "./abandonment.filters.js";
import { validateListAbandonmentsQuery } from "./abandonment.validators.js";

const iso = (r: { gte: Date; lt: Date } | null) => (r ? [r.gte.toISOString(), r.lt.toISOString()] : null);

describe("abandonmentDateRangeBounds (IST calendar days)", () => {
  it("today = 00:00 IST .. next 00:00 IST, expressed in UTC", () => {
    // 2026-10-13 10:30 IST
    assert.deepEqual(iso(abandonmentDateRangeBounds("today", new Date("2026-10-13T05:00:00Z"))), ["2026-10-12T18:30:00.000Z", "2026-10-13T18:30:00.000Z"]);
  });

  it("yesterday = the IST day before, ending exactly where today starts", () => {
    assert.deepEqual(iso(abandonmentDateRangeBounds("yesterday", new Date("2026-10-13T05:00:00Z"))), ["2026-10-11T18:30:00.000Z", "2026-10-12T18:30:00.000Z"]);
    const t = abandonmentDateRangeBounds("today", new Date("2026-10-13T05:00:00Z"))!;
    const y = abandonmentDateRangeBounds("yesterday", new Date("2026-10-13T05:00:00Z"))!;
    assert.equal(y.lt.getTime(), t.gte.getTime(), "no gap and no overlap between the two days");
  });

  it("the IST midnight is the boundary - NOT UTC midnight and not the server's/browser's zone", () => {
    // 23:59:59 IST on the 12th is still the 12th; one second later it is the 13th.
    assert.equal(abandonmentDateRangeBounds("today", new Date("2026-10-12T18:29:59Z"))!.gte.toISOString(), "2026-10-11T18:30:00.000Z");
    assert.equal(abandonmentDateRangeBounds("today", new Date("2026-10-12T18:30:00Z"))!.gte.toISOString(), "2026-10-12T18:30:00.000Z");
    // 01:00 IST on the 13th is 19:30 UTC on the 12th: UTC says "12th", IST says "13th".
    assert.equal(abandonmentDateRangeBounds("today", new Date("2026-10-12T19:30:00Z"))!.gte.toISOString(), "2026-10-12T18:30:00.000Z");
  });

  it("month / year / leap-day rollovers", () => {
    assert.deepEqual(iso(abandonmentDateRangeBounds("yesterday", new Date("2026-11-01T05:00:00Z"))), ["2026-10-30T18:30:00.000Z", "2026-10-31T18:30:00.000Z"]);
    assert.deepEqual(iso(abandonmentDateRangeBounds("yesterday", new Date("2027-01-01T05:00:00Z"))), ["2026-12-30T18:30:00.000Z", "2026-12-31T18:30:00.000Z"]);
    assert.deepEqual(iso(abandonmentDateRangeBounds("yesterday", new Date("2028-03-01T05:00:00Z"))), ["2028-02-28T18:30:00.000Z", "2028-02-29T18:30:00.000Z"], "29 Feb 2028 exists");
  });

  it("all / no filter = no restriction", () => {
    assert.equal(abandonmentDateRangeBounds("all"), null);
    assert.equal(abandonmentDateRangeBounds(undefined), null);
  });
});

describe("dateRange query parameter validation", () => {
  it("accepts today, yesterday and all; an empty value means 'not set'; anything else is rejected with a clear message", () => {
    for (const v of ["today", "yesterday", "all"]) assert.equal(validateListAbandonmentsQuery({ dateRange: v }).value?.dateRange, v);
    assert.equal(validateListAbandonmentsQuery({ dateRange: "" }).value?.dateRange, undefined);
    assert.equal(validateListAbandonmentsQuery({}).value?.dateRange, undefined, "existing callers are unaffected");
    for (const bad of ["week", "TODAY", "2026-10-13", "1", "today,all", "'; drop table"]) {
      const r = validateListAbandonmentsQuery({ dateRange: bad });
      assert.ok(r.error, bad);
      assert.match(r.error!.message, /dateRange must be today, yesterday or all/);
    }
  });
});
