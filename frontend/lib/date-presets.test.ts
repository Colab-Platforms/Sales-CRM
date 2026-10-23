// Run with: ../backend/node_modules/.bin/tsx --test lib/date-presets.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dayCount, istToday, monthEnd, presetError, resolvePreset, weekStart } from "./date-presets";

// Thursday 22 Oct 2026, 10:00 IST.
const now = new Date("2026-10-22T04:30:00.000Z");
const r = (preset: Parameters<typeof resolvePreset>[0]["preset"], extra = {}) => resolvePreset({ preset, ...extra }, now);

describe("date presets (IST, inclusive)", () => {
  it("today / yesterday / day before yesterday are single historical days", () => {
    assert.deepEqual(r("today"), { from: "2026-10-22", to: "2026-10-22" });
    assert.deepEqual(r("yesterday"), { from: "2026-10-21", to: "2026-10-21" });
    assert.deepEqual(r("dayBefore"), { from: "2026-10-20", to: "2026-10-20" });
  });

  it("last N days include today and have exactly N days", () => {
    assert.equal(dayCount(r("5d").from, r("5d").to), 5);
    assert.equal(dayCount(r("7d").from, r("7d").to), 7);
    assert.equal(dayCount(r("30d").from, r("30d").to), 30);
    assert.equal(r("7d").to, "2026-10-22");
  });

  it("weeks run Monday to Sunday; this week stops at today", () => {
    assert.deepEqual(r("thisWeek"), { from: "2026-10-19", to: "2026-10-22" });
    assert.deepEqual(r("lastWeek"), { from: "2026-10-12", to: "2026-10-18" });
    assert.equal(weekStart("2026-10-18"), "2026-10-12"); // a Sunday belongs to the week before
  });

  it("this month / last month, across year ends and leap years", () => {
    assert.deepEqual(r("month"), { from: "2026-10-01", to: "2026-10-22" });
    assert.deepEqual(r("lastMonth"), { from: "2026-09-01", to: "2026-09-30" });
    assert.deepEqual(resolvePreset({ preset: "lastMonth" }, new Date("2028-03-05T06:00:00Z")), { from: "2028-02-01", to: "2028-02-29" });
    assert.deepEqual(resolvePreset({ preset: "lastMonth" }, new Date("2027-01-10T06:00:00Z")), { from: "2026-12-01", to: "2026-12-31" });
    assert.equal(monthEnd("2026-02-10"), "2026-02-28");
  });

  it("uses India time: 00:30 IST is already the next day", () => {
    assert.equal(istToday(new Date("2026-10-21T19:00:00.000Z")), "2026-10-22");
  });

  it("single date and custom range, with validation", () => {
    assert.deepEqual(r("single", { single: "2026-10-03" }), { from: "2026-10-03", to: "2026-10-03" });
    assert.deepEqual(r("custom", { from: "2026-10-01", to: "2026-10-05" }), { from: "2026-10-01", to: "2026-10-05" });
    assert.equal(presetError({ preset: "custom", from: "2026-10-05", to: "2026-10-01" }, now), "From date must not be after To date.");
    assert.equal(presetError({ preset: "single", single: "2026-10-23" }, now), "The date cannot be in the future.");
    assert.equal(presetError({ preset: "custom", from: "2026-10-01", to: "2026-10-22" }, now), null);
  });
});
