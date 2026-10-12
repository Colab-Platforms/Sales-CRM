import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkStatus } from "../../../generated/prisma/enums.js";
import { computeSummary, dayBounds, mergeSummaries, todayString } from "./attendance.calc.js";
import { validateReportQuerySchema, validateSetStatusSchema } from "./attendance.validators.js";
import type { LogInterval } from "./attendance.types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = new Date("2026-10-08T04:00:00.000Z");
const at = (minutes: number) => new Date(START.getTime() + minutes * MIN);
const log = (status: WorkStatus, from: number, to: number | null): LogInterval => ({
  status,
  startedAt: at(from),
  endedAt: to === null ? null : at(to),
});

describe("computeSummary", () => {
  it("counts tea, lunch and bio together as breaks", () => {
    const s = computeSummary(
      [
        log(WorkStatus.ACTIVE, 0, 60),
        log(WorkStatus.TEA_BREAK, 60, 70),
        log(WorkStatus.LUNCH_BREAK, 70, 100),
        log(WorkStatus.BIO_BREAK, 100, 105),
        log(WorkStatus.ACTIVE, 105, null),
      ],
      START,
      at(240),
    );
    assert.equal(s.teaMs, 10 * MIN);
    assert.equal(s.lunchMs, 30 * MIN);
    assert.equal(s.bioMs, 5 * MIN);
    assert.equal(s.breakTotalMs, 45 * MIN);
    assert.equal(s.breakRemainingMs, 15 * MIN);
    assert.equal(s.breakOverageMs, 0);
  });

  it("flags break overage past one hour", () => {
    const s = computeSummary([log(WorkStatus.LUNCH_BREAK, 0, 75), log(WorkStatus.ACTIVE, 75, null)], START, at(120));
    assert.equal(s.breakOverageMs, 15 * MIN);
    assert.equal(s.breakRemainingMs, 0);
  });

  it("keeps team huddle out of the break total but deducts it from productive time", () => {
    const s = computeSummary([log(WorkStatus.TEAM_HUDDLE, 0, 30), log(WorkStatus.ACTIVE, 30, null)], START, at(120));
    assert.equal(s.huddleMs, 30 * MIN);
    assert.equal(s.breakTotalMs, 0);
    assert.equal(s.productiveMs, 90 * MIN);
  });

  it("does not deduct calling or idle time from productive time", () => {
    const s = computeSummary(
      [log(WorkStatus.ON_CALL, 0, 60), log(WorkStatus.IDLE, 60, 90), log(WorkStatus.ACTIVE, 90, null)],
      START,
      at(120),
    );
    assert.equal(s.callingMs, 60 * MIN);
    assert.equal(s.idleMs, 30 * MIN);
    assert.equal(s.productiveMs, 120 * MIN);
  });

  it("measures an open interval up to the end of the shift window", () => {
    const s = computeSummary([log(WorkStatus.TEA_BREAK, 0, null)], START, at(20));
    assert.equal(s.teaMs, 20 * MIN);
  });

  it("tracks the 9h shift countdown and the 8h target", () => {
    const early = computeSummary([log(WorkStatus.ACTIVE, 0, null)], START, at(60));
    assert.equal(early.shiftRemainingMs, 8 * HOUR);
    assert.equal(early.shiftOverrunMs, 0);
    assert.equal(early.targetMet, false);

    const full = computeSummary([log(WorkStatus.ACTIVE, 0, null)], START, at(9 * 60 + 30));
    assert.equal(full.shiftRemainingMs, 0);
    assert.equal(full.shiftOverrunMs, 30 * MIN);
    assert.equal(full.targetMet, true);
  });
});

describe("mergeSummaries", () => {
  it("re-derives limits from combined totals across shifts", () => {
    const a = computeSummary([log(WorkStatus.LUNCH_BREAK, 0, 40)], START, at(40));
    const b = computeSummary([log(WorkStatus.TEA_BREAK, 0, 30)], START, at(30));
    const merged = mergeSummaries([a, b]);
    assert.equal(merged.breakTotalMs, 70 * MIN);
    assert.equal(merged.breakOverageMs, 10 * MIN);
    assert.equal(merged.shiftElapsedMs, 70 * MIN);
  });
});

describe("report day bounds", () => {
  it("cuts the day at midnight in the reporting zone", () => {
    const { from, to } = dayBounds("2026-10-08", 330);
    assert.equal(from.toISOString(), "2026-10-07T18:30:00.000Z");
    assert.equal(to.toISOString(), "2026-10-08T18:30:00.000Z");
  });

  it("reports today's date in the reporting zone", () => {
    assert.equal(todayString(new Date("2026-10-07T19:00:00.000Z"), 330), "2026-10-08");
  });
});

describe("attendance validators", () => {
  it("accepts a known status and rejects an unknown one", () => {
    assert.equal(validateSetStatusSchema({ status: "TEA_BREAK" }).error, null);
    assert.ok(validateSetStatusSchema({ status: "SLEEPING" }).error);
  });

  it("validates the report query", () => {
    assert.equal(validateReportQuerySchema({ date: "2026-10-08" }).error, null);
    assert.ok(validateReportQuerySchema({ date: "08-10-2026" }).error);
    assert.ok(validateReportQuerySchema({ userId: "nope" }).error);
  });
});
