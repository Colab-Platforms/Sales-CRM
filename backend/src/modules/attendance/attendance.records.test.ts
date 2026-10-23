import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionEndReason, WorkStatus } from "../../../generated/prisma/enums.js";
import { dayRecord, listDays, matchesStatus, totalsOf, zoneDay, type SessionForDay } from "./attendance.records.js";

const TZ = 330;
const now = new Date("2026-10-22T12:00:00.000Z"); // 17:30 IST on Oct 22
const base = { today: "2026-10-22", joinedOn: "2026-10-01", trackingStartedOn: "2026-10-08", now, tzOffsetMinutes: TZ };
// An IST wall-clock time on a date, as a UTC instant.
const ist = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00.000Z`) - TZ * 60_000);
const session = (start: Date, end: Date | null, over: Partial<SessionForDay> = {}): SessionForDay => ({
  startedAt: start,
  endedAt: end,
  endReason: end ? SessionEndReason.LOGOUT : null,
  lastSeenAt: end ?? now,
  logs: [{ status: WorkStatus.ACTIVE, startedAt: start, endedAt: end }],
  ...over,
});

describe("date ranges", () => {
  it("are inclusive of both ends", () => {
    assert.deepEqual(listDays("2026-10-18", "2026-10-22"), ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]);
    assert.deepEqual(listDays("2026-10-22", "2026-10-22"), ["2026-10-22"]);
  });

  it("cross month ends correctly", () => {
    assert.deepEqual(listDays("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  it("put a 00:30 IST clock-in on the IST day, not the previous UTC day", () => {
    assert.equal(zoneDay(ist("2026-10-20", "00:30"), TZ), "2026-10-20");
  });
});

describe("day status", () => {
  it("any valid clock-in is Present", () => {
    const r = dayRecord({ ...base, date: "2026-10-20", sessions: [session(ist("2026-10-20", "09:45"), ist("2026-10-20", "18:45"))] });
    assert.equal(r.status, "PRESENT");
    assert.equal(r.workingMs, 9 * 3600_000);
  });

  it("there is no Late status: a clock-in after the 09:45 cut-off is still Present", () => {
    const r = dayRecord({ ...base, date: "2026-10-20", sessions: [session(ist("2026-10-20", "10:15"), ist("2026-10-20", "18:00"))] });
    assert.equal(r.status, "PRESENT");
    assert.ok(!r.remarks.some((x) => /late/i.test(x)));
  });

  it("no clock-in on a past working day is Absent; today is Pending until the late cut-off, then Absent; before joining is Not joined", () => {
    assert.equal(dayRecord({ ...base, date: "2026-10-20", sessions: [] }).status, "ABSENT");
    assert.equal(dayRecord({ ...base, date: "2026-10-22", sessions: [] }).status, "ABSENT");
    assert.equal(dayRecord({ ...base, now: ist("2026-10-22", "09:45"), date: "2026-10-22", sessions: [] }).status, "PENDING");
    assert.equal(dayRecord({ ...base, now: ist("2026-10-22", "09:46"), date: "2026-10-22", sessions: [] }).status, "ABSENT");
    assert.equal(dayRecord({ ...base, date: "2026-10-23", sessions: [] }).status, "PENDING");
    assert.equal(dayRecord({ ...base, joinedOn: "2026-10-21", date: "2026-10-20", sessions: [] }).status, "NOT_JOINED");
    // Before the CRM recorded any attendance, nobody could clock in: not an absence.
    assert.equal(dayRecord({ ...base, date: "2026-10-05", sessions: [] }).status, "NOT_TRACKED");
    assert.equal(dayRecord({ ...base, trackingStartedOn: null, date: "2026-10-20", sessions: [] }).status, "NOT_TRACKED");
  });

  it("several sessions in a day are one record: first check-in, last check-out, hours added", () => {
    const r = dayRecord({
      ...base,
      date: "2026-10-20",
      sessions: [
        session(ist("2026-10-20", "14:00"), ist("2026-10-20", "18:00")),
        session(ist("2026-10-20", "09:30"), ist("2026-10-20", "13:00")),
      ],
    });
    assert.equal(r.status, "PRESENT");
    assert.equal(r.checkIn, ist("2026-10-20", "09:30").toISOString());
    assert.equal(r.checkOut, ist("2026-10-20", "18:00").toISOString());
    assert.equal(r.workingMs, 7.5 * 3600_000);
    assert.equal(r.sessions, 2);
  });

  it("an open session has no check-out and is flagged; an auto clock-out is flagged", () => {
    const open = dayRecord({ ...base, date: "2026-10-22", sessions: [session(ist("2026-10-22", "09:00"), null)] });
    assert.equal(open.checkOut, null);
    assert.equal(open.stillWorking, true);
    assert.ok(open.remarks.includes("Still working"));
    const stale = dayRecord({
      ...base,
      date: "2026-10-20",
      sessions: [session(ist("2026-10-20", "09:00"), ist("2026-10-20", "11:00"), { endReason: SessionEndReason.STALE })],
    });
    assert.ok(stale.remarks.some((x) => x.startsWith("Auto clocked out")));
  });
});

describe("totals", () => {
  it("count employee-days, ignore pending and pre-joining days, and never divide by zero", () => {
    const rec = (status: "PRESENT" | "ABSENT" | "PENDING" | "NOT_JOINED" | "NOT_TRACKED") => ({ ...dayRecord({ ...base, date: "2026-10-20", sessions: [] }), status });
    const t = totalsOf([rec("PRESENT"), rec("PRESENT"), rec("ABSENT"), rec("PENDING"), rec("NOT_JOINED"), rec("NOT_TRACKED")]);
    // Only Present and Absent days are eligible working days; the rest are neither counted nor shown as a status.
    assert.deepEqual([t.present, t.absent, t.expected, t.attended], [2, 1, 3, 2]);
    assert.equal(t.attendancePct, 66.7);
    assert.equal(totalsOf([rec("PENDING")]).attendancePct, null);
  });

  it("the status filter keeps only that status", () => {
    assert.equal(matchesStatus("ABSENT", "ABSENT"), true);
    assert.equal(matchesStatus("PRESENT", "ABSENT"), false);
    assert.equal(matchesStatus("PENDING", "ALL"), true);
  });
});

describe("records query validation", () => {
  it("accepts real dates and rejects malformed or reversed ranges", async () => {
    const { validateRecordsQuerySchema } = await import("./attendance.validators.js");
    const ok = validateRecordsQuerySchema({ from: "2026-10-13", to: "2026-10-19" });
    assert.equal(ok.error, null);
    assert.equal(ok.value?.status, "ALL");
    assert.ok(validateRecordsQuerySchema({ from: "dddd-dd-dd", to: "2026-10-19" }).error);
    assert.ok(validateRecordsQuerySchema({ from: "2026-10-19", to: "2026-10-13" }).error);
  });
});

describe("calls and talk time", () => {
  it("are carried on the day record (even on an absent day) and summed in totals", () => {
    const worked = dayRecord({
      ...base,
      date: "2026-10-20",
      sessions: [session(ist("2026-10-20", "09:30"), ist("2026-10-20", "18:00"))],
      callStats: { calls: 12, talkTimeSec: 1800 },
    });
    const absent = dayRecord({ ...base, date: "2026-10-19", sessions: [], callStats: { calls: 2, talkTimeSec: 120 } });
    const none = dayRecord({ ...base, date: "2026-10-18", sessions: [] });
    assert.deepEqual([worked.calls, worked.talkTimeSec, absent.talkTimeSec, none.calls, none.talkTimeSec], [12, 1800, 120, 0, 0]);
    const t = totalsOf([worked, absent, none]);
    assert.deepEqual([t.calls, t.talkTimeSec], [14, 1920]);
  });
});
