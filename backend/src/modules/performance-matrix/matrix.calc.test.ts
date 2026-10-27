import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSlots, coveredMinutes, dayGate, rate, slotGate, slotOf, teamPace, zoneClock, zoneInstant, type Gate } from "./matrix.calc.js";

const TZ = 330;
const ist = (day: string, t: string) => new Date(Date.parse(`${day}T${t}:00.000Z`) - TZ * 60_000);
const offState = (g: Gate) => ("off" in g ? g.off.state : "RATED");

describe("slots and bucketing", () => {
  const slots = buildSlots();
  it("hourly slots for the 09:30-18:30 working day", () => {
    assert.deepEqual(slots.map((s) => s.key), ["09:30", "10:30", "11:30", "12:30", "13:30", "14:30", "15:30", "16:30", "17:30"]);
  });
  it("a call exactly on a boundary belongs to the later slot only (half-open), so nothing is counted twice", () => {
    assert.equal(slotOf(zoneClock(ist("2026-10-20", "10:30"), TZ).minutes, slots)!.key, "10:30");
    assert.equal(slotOf(zoneClock(ist("2026-10-20", "10:29"), TZ).minutes, slots)!.key, "09:30");
  });
  it("before/after hours go to Outside hours", () => {
    for (const t of ["09:00", "18:30"]) assert.equal(slotOf(zoneClock(ist("2026-10-20", t), TZ).minutes, slots), null);
  });
  it("uses IST days: 00:30 IST is that IST day", () => assert.equal(zoneClock(ist("2026-10-20", "00:30"), TZ).day, "2026-10-20"));
  it("clocked-in minutes merge overlapping sessions", () => {
    const s = [
      { start: ist("2026-10-20", "13:00"), end: ist("2026-10-20", "14:15") },
      { start: ist("2026-10-20", "13:10"), end: ist("2026-10-20", "13:20") },
    ];
    assert.equal(coveredMinutes("2026-10-20", 12 * 60 + 30, 14 * 60 + 30, s, TZ), 75);
  });
});

describe("automatic RAG against the team's pace", () => {
  it("team pace is calls and orders per logged-in hour across the team", () => {
    assert.deepEqual(teamPace([{ calls: 12, orders: 1, minutes: 60 }, { calls: 3, orders: 2, minutes: 30 }]), { calls: 10, orders: 2 });
    assert.deepEqual(teamPace([]), { calls: 0, orders: 0 });
  });
  it("calls only (team had no orders): Green from 80% of the team average, Amber from 50%, Red below", () => {
    const hour = (calls: number) => rate({ calls, orders: 0, minutes: 60 }, { calls: 10, orders: 0 }).state;
    assert.equal(hour(8), "GREEN");
    assert.equal(hour(5), "AMBER");
    assert.equal(hour(4), "RED");
  });
  it("part-hours are judged pro rata to the time logged in", () => assert.match(rate({ calls: 4, orders: 0, minutes: 30 }, { calls: 10, orders: 0 }).reason, /team avg 5\).*score 80%/));
  it("calls and orders weigh equally against the team", () => {
    const pace = { calls: 10, orders: 1 };
    assert.equal(rate({ calls: 10, orders: 1, minutes: 60 }, pace).state, "GREEN"); // (100% + 100%) / 2
    assert.equal(rate({ calls: 5, orders: 1, minutes: 60 }, pace).state, "AMBER"); // (50% + 100%) / 2 = 75%
    assert.equal(rate({ calls: 12, orders: 0, minutes: 60 }, pace).state, "AMBER"); // (120% + 0%) / 2 = 60%
    assert.equal(rate({ calls: 3, orders: 0, minutes: 60 }, pace).state, "RED"); // (30% + 0%) / 2 = 15%
  });
  it("when orders are rare (team avg under 1), no order is not held against anyone, but one still helps", () => {
    const pace = { calls: 10, orders: 0.2 };
    assert.equal(rate({ calls: 9, orders: 0, minutes: 60 }, pace).state, "GREEN"); // calls 90%
    assert.equal(rate({ calls: 6, orders: 1, minutes: 60 }, pace).state, "GREEN"); // (60% + 120%) / 2 = 90%
  });
  it("orders cannot hide very few calls (each share is capped at 120%)", () => {
    assert.equal(rate({ calls: 2, orders: 3, minutes: 60 }, { calls: 10, orders: 1 }).state, "AMBER"); // (20% + 120%) / 2 = 70%
  });
  it("nothing at all while logged in is Red even when the whole team is quiet", () => assert.equal(rate({ calls: 0, orders: 0, minutes: 60 }, { calls: 0, orders: 0 }).state, "RED"));
});

describe("hour gate", () => {
  const slot = buildSlots().find((s) => s.key === "10:30")!;
  const base = {
    slot,
    calls: 3,
    orders: 0,
    covered: 60,
    startsAt: zoneInstant("2026-10-20", slot.startMinutes, TZ),
    endsAt: zoneInstant("2026-10-20", slot.endMinutes, TZ),
    now: ist("2026-10-21", "12:00"),
    teamHasCalls: true,
  };
  it("rates a finished hour", () => assert.deepEqual(slotGate(base), { minutes: 60 }));
  it("is never rated just because the hour has started or not finished", () => {
    assert.equal(offState(slotGate({ ...base, now: ist("2026-10-20", "10:35") })), "IN_PROGRESS");
    assert.equal(offState(slotGate({ ...base, now: ist("2026-10-20", "09:00") })), "UPCOMING");
  });
  it("off-shift idle hours and a missing call feed are not rated", () => {
    assert.equal(offState(slotGate({ ...base, calls: 0, covered: 0 })), "OFF_SHIFT");
    assert.equal(offState(slotGate({ ...base, teamHasCalls: false })), "NO_DATA");
  });
  it("activity without a clock-in is judged against the full hour", () => assert.deepEqual(slotGate({ ...base, covered: 0 }), { minutes: 60 }));
});

describe("day gate", () => {
  const base = { calls: 60, orders: 0, covered: 540, dayMinutes: 540, isToday: false, teamHasCalls: true };
  it("a worked day is rated on the minutes clocked in", () => assert.deepEqual(dayGate({ ...base, covered: 300 }), { minutes: 300 }));
  it("today waits for the first hour", () => assert.equal(offState(dayGate({ ...base, isToday: true, covered: 30, calls: 0 })), "IN_PROGRESS"));
  it("not clocked in with no activity, or no call feed, is never Red", () => {
    assert.equal(offState(dayGate({ ...base, covered: 0, calls: 0 })), "OFF_SHIFT");
    assert.equal(offState(dayGate({ ...base, teamHasCalls: false })), "NO_DATA");
  });
});
