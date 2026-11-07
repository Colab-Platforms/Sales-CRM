import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, evaluateMonth, monthDays, policyError, slabFor, type DayInput, type MonthInput, type OrderTotals } from "./incentives.calc.js";

const goodDay = (date: string): DayInput => ({ date, attendance: "PRESENT", netLoginMinutes: 500, calls: 120, orders: 13 });
const orders = (o: Partial<OrderTotals> = {}): OrderTotals => ({ total: 100, prepaid: 50, delivered: 90, returned: 5, inTransit: 5, notDispatched: 0, ...o });

/** A finished October: 27 good days, 4 days off. */
function october(over: Partial<MonthInput> = {}, dayPatch: (d: DayInput, i: number) => DayInput = (d) => d): MonthInput {
  const days = monthDays("2026-10").map((date, i) => dayPatch(i < 27 ? goodDay(date) : { date, attendance: "ABSENT", netLoginMinutes: 0, calls: 0, orders: 0 }, i));
  return { month: "2026-10", today: "2026-11-07", days, revenue: 135000, orders: orders({ total: 27 * 13, prepaid: 200, delivered: 300, returned: 20, inTransit: 31 }), policy: DEFAULT_POLICY, ...over };
}
const light = (r: ReturnType<typeof evaluateMonth>, key: string) => r.conditions.find((c) => c.key === key)!.light;

describe("revenue slabs", () => {
  it("applies only the highest slab reached, never a sum", () => {
    assert.equal(slabFor(135000, DEFAULT_POLICY).amount, 1500);
    assert.equal(slabFor(250000, DEFAULT_POLICY).amount, 4000);
    assert.equal(slabFor(99999, DEFAULT_POLICY).amount, null);
  });
  it("next slab and the revenue still needed", () => {
    const s = slabFor(135000, DEFAULT_POLICY);
    assert.equal(s.next!.minRevenue, 150000);
    assert.equal(s.next!.minRevenue - 135000, 15000);
  });
  it("never assumes how the 2.5% applies: no amount until the admin confirms the basis", () => {
    const s = slabFor(320000, DEFAULT_POLICY);
    assert.equal(s.amount, null);
    assert.match(s.note!, /confirm/);
    assert.equal(slabFor(320000, { ...DEFAULT_POLICY, percentBasis: "TOTAL" }).amount, 8000);
    assert.equal(slabFor(320000, { ...DEFAULT_POLICY, percentBasis: "ABOVE_SLAB" }).amount, 500);
  });
});

describe("a finished month", () => {
  it("all six conditions met and a slab reached = Eligible, awaiting approval", () => {
    const r = evaluateMonth(october({ orders: orders({ total: 351, prepaid: 200, delivered: 300, returned: 20, inTransit: 0, notDispatched: 31 }) }));
    // 300/351 = 85.5% delivered
    assert.deepEqual(r.conditions.map((c) => c.light), ["GREEN", "GREEN", "GREEN", "GREEN", "GREEN", "GREEN"]);
    assert.equal(r.status, "ELIGIBLE");
    assert.equal(r.potentialIncentive, 1500);
  });
  it("failing any one mandatory condition means Not Eligible and no incentive", () => {
    const r = evaluateMonth(october({ orders: orders({ total: 351, prepaid: 100, delivered: 300, inTransit: 0 }) })); // 28.5% prepaid
    assert.equal(light(r, "PREPAID"), "RED");
    assert.equal(r.status, "NOT_ELIGIBLE");
    assert.equal(r.potentialIncentive, 0);
  });
  it("one short day of calls is not hidden by a monthly average", () => {
    // 27 days present; two days with 60 calls -> only 25 qualifying days, although the average is well above 100.
    const r = evaluateMonth(october({}, (d, i) => (i < 2 ? { ...d, calls: 60 } : i < 27 ? { ...d, calls: 200 } : d)));
    assert.equal(r.totals.callDays, 25);
    assert.equal(light(r, "DAILY_CALLS"), "RED");
    assert.equal(r.status, "NOT_ELIGIBLE");
  });
  it("net login is checked day by day against 8 hours", () => {
    const r = evaluateMonth(october({}, (d, i) => (i < 2 ? { ...d, netLoginMinutes: 470 } : d)));
    assert.equal(r.totals.loginDays, 25);
    assert.equal(light(r, "NET_LOGIN"), "RED");
  });
  it("orders still in transit make delivery pending, not failed", () => {
    // 250 delivered of 351 = 71%, but 351 if all in-transit arrive -> could still reach 80%
    const r = evaluateMonth(october({ orders: orders({ total: 351, prepaid: 200, delivered: 250, inTransit: 101, returned: 0 }) }));
    assert.equal(light(r, "DELIVERY"), "AMBER");
    assert.equal(r.status, "PENDING_VERIFICATION");
  });
  it("revenue below the first slab is Not Eligible", () => {
    assert.equal(evaluateMonth(october({ revenue: 90000 })).status, "NOT_ELIGIBLE");
  });
  it("a 2.5% slab with no confirmed basis waits for the admin", () => {
    const r = evaluateMonth(october({ revenue: 310000, orders: orders({ total: 351, prepaid: 200, delivered: 300, inTransit: 0 }) }));
    assert.equal(r.status, "PENDING_VERIFICATION");
    assert.equal(r.slabIncentive, null);
  });
});

describe("the current month", () => {
  const nov = (presentSoFar: number): MonthInput => ({
    month: "2026-11",
    today: "2026-11-07",
    days: monthDays("2026-11").map((date, i) => (i < presentSoFar ? goodDay(date) : date > "2026-11-07" ? { date, attendance: "UPCOMING", netLoginMinutes: 0, calls: 0, orders: 0 } : { date, attendance: "ABSENT", netLoginMinutes: 0, calls: 0, orders: 0 })),
    revenue: 40000,
    orders: orders({ total: 70, prepaid: 20, delivered: 10, inTransit: 60 }),
    policy: DEFAULT_POLICY,
  });
  it("is In Progress; unmet conditions are Amber while still reachable", () => {
    const r = evaluateMonth(nov(6));
    assert.equal(r.status, "IN_PROGRESS");
    assert.equal(light(r, "ATTENDANCE"), "AMBER"); // 6 + 24 days left
    assert.equal(light(r, "PREPAID"), "AMBER");
  });
  it("turns Red once 26 days can no longer be reached", () => {
    // 1 day present by the 7th: 1 + 24 days left (7th..30th) = 25 < 26
    const r = evaluateMonth(nov(1));
    assert.equal(light(r, "ATTENDANCE"), "RED");
    assert.equal(r.potentialIncentive, 0);
  });
  it("daily rows mark today and the days to come", () => {
    const r = evaluateMonth(nov(7));
    assert.equal(r.daily.find((d) => d.date === "2026-11-07")!.status, "TODAY");
    assert.equal(r.daily.find((d) => d.date === "2026-11-08")!.status, "UPCOMING");
    assert.equal(r.daily.find((d) => d.date === "2026-11-01")!.status, "MET");
  });
});

describe("policy validation", () => {
  it("accepts the sheet and rejects broken slabs", () => {
    assert.equal(policyError(DEFAULT_POLICY), null);
    assert.match(policyError({ ...DEFAULT_POLICY, slabs: [{ minRevenue: 100000 }] })!, /amount or a percentage/);
    assert.match(policyError({ ...DEFAULT_POLICY, slabs: [{ minRevenue: 1, amount: 1 }, { minRevenue: 1, amount: 2 }] })!, /same revenue/);
  });
});
