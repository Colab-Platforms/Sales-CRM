// Pure tests (no database): the dashboard's date range in the business timezone, source / fulfilment classification and the request validation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OrderStatus } from "../../../generated/prisma/enums.js";
import { BUSINESS_TIMEZONE, MAX_RANGE_DAYS, resolveDashboardRange, DashboardRangeError } from "./orders.dashboard.range.js";
import { fulfilmentOf, sectionOf } from "./orders.dashboard.service.js";
import { validateAbandonedFilters, validateAbandonedList, validateFilters, validateList } from "./orders.dashboard.validators.js";
import { ABANDONED_METRICS, abandonedMetricWhere, followUpOf } from "./abandoned.dashboard.service.js";

const IST = "Asia/Kolkata";
// 11:30 IST on Monday 26 Oct 2026
const NOW = new Date("2026-10-26T06:00:00Z");

describe("dashboard date range (business timezone)", () => {
  it("the business timezone is Asia/Kolkata unless configured", () => assert.equal(BUSINESS_TIMEZONE, "Asia/Kolkata"));

  it("with no input the default is YESTERDAY, not today: the previous IST day, 00:00 to 00:00", () => {
    const r = resolveDashboardRange({}, NOW, IST);
    assert.deepEqual([r.range, r.from, r.to], ["yesterday", "2026-10-25", "2026-10-25"]);
    assert.equal(r.start.toISOString(), "2026-10-24T18:30:00.000Z");
    assert.equal(r.end.toISOString(), "2026-10-25T18:30:00.000Z");
  });

  it("the default follows the IST date, not the UTC date: at 00:10 IST on the 26th (18:40Z on the 25th) yesterday is the 25th; at 23:50 IST on the 25th (18:20Z) yesterday is the 24th", () => {
    assert.equal(resolveDashboardRange({}, new Date("2026-10-25T18:40:00Z"), IST).from, "2026-10-25", "00:10 IST on the 26th -> yesterday = 25th");
    assert.equal(resolveDashboardRange({}, new Date("2026-10-25T18:20:00Z"), IST).from, "2026-10-24", "23:50 IST on the 25th -> yesterday = 24th");
  });

  it("today and an explicit yesterday", () => {
    const t = resolveDashboardRange({ range: "today" }, NOW, IST);
    assert.deepEqual([t.from, t.to, t.start.toISOString(), t.end.toISOString()], ["2026-10-26", "2026-10-26", "2026-10-25T18:30:00.000Z", "2026-10-26T18:30:00.000Z"]);
    assert.equal(resolveDashboardRange({ range: "yesterday" }, NOW, IST).from, "2026-10-25");
  });

  it("a custom range is inclusive of both days; from/to alone imply custom", () => {
    const r = resolveDashboardRange({ from: "2026-10-20", to: "2026-10-22" }, NOW, IST);
    assert.deepEqual([r.range, r.from, r.to], ["custom", "2026-10-20", "2026-10-22"]);
    assert.equal(r.start.toISOString(), "2026-10-19T18:30:00.000Z");
    assert.equal(r.end.toISOString(), "2026-10-22T18:30:00.000Z");
  });

  it("validation: both dates real, from <= to, not in the future, at most a year; messages are clear", () => {
    const bad = (input: object) => assert.throws(() => resolveDashboardRange({ range: "custom", ...input }, NOW, IST), DashboardRangeError);
    bad({});
    bad({ from: "2026-10-20" });
    bad({ from: "2026-02-30", to: "2026-03-01" });
    bad({ from: "26-10-2026", to: "27-10-2026" });
    bad({ from: "2026-10-22", to: "2026-10-20" });
    bad({ from: "2026-10-20", to: "2026-10-27" }); // tomorrow in IST
    bad({ from: "2025-01-01", to: "2026-10-26" }); // > 366 days
    assert.equal(resolveDashboardRange({ range: "custom", from: "2025-10-26", to: "2026-10-26" }, NOW, IST).from, "2025-10-26");
    assert.equal(MAX_RANGE_DAYS, 366);
    assert.throws(() => resolveDashboardRange({ range: "custom", from: "2026-10-22", to: "2026-10-20" }, NOW, IST), /From date must be on or before/);
  });

  it("a different timezone shifts the boundaries (and a daylight-saving zone is honoured)", () => {
    const ny = resolveDashboardRange({ range: "yesterday" }, new Date("2026-10-26T12:00:00Z"), "America/New_York");
    assert.equal(ny.start.toISOString(), "2026-10-25T04:00:00.000Z"); // EDT = UTC-4
  });
});

describe("classification", () => {
  it("source -> section: SALESPERSON is a telecaller order; SHOPIFY and WEBSITE are website orders; API is neither", () => {
    assert.deepEqual(["SALESPERSON", "SHOPIFY", "WEBSITE", "API"].map(sectionOf), ["TELECALLER", "WEBSITE", "WEBSITE", "OTHER"]);
  });
  it("order status -> fulfilment", () => {
    assert.deepEqual([OrderStatus.CONFIRMED, OrderStatus.PENDING_PAYMENT, OrderStatus.PROCESSING].map(fulfilmentOf), ["UNFULFILLED", "UNFULFILLED", "UNFULFILLED"]);
    assert.deepEqual([OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED].map(fulfilmentOf), ["FULFILLED", "FULFILLED", "FULFILLED"]);
    assert.deepEqual([OrderStatus.CANCELLED, OrderStatus.RETURNED, OrderStatus.REFUNDED, OrderStatus.DRAFT].map(fulfilmentOf), ["CANCELLED", "RETURNED", "RETURNED", "DRAFT"]);
  });
});

describe("request validation", () => {
  it("accepts the filters, treats empty strings as absent, and caps the page size", () => {
    const v = validateFilters({ range: "", section: "WEBSITE", search: " ab ", paymentStatus: "SUCCESS" }).value;
    assert.deepEqual([v.range, v.section, v.search, v.paymentStatus], [undefined, "WEBSITE", "ab", "SUCCESS"]);
    const l = validateList({ page: "2", pageSize: "50" });
    assert.deepEqual([l.error, l.value.page, l.value.pageSize], [null, 2, 50]);
    assert.deepEqual([validateList({}).value.page, validateList({}).value.pageSize], [1, 25]);
    assert.ok(validateList({ pageSize: "1000" }).error);
    assert.ok(validateList({ page: "0" }).error);
  });
  it("every summary card is a known metric; an unknown card is refused", () => {
    for (const m of ["TOTAL", "VALUE", "COD", "PREPAID", "PAID", "PENDING", "CANCELLED", "FULFILLED"]) assert.equal(validateList({ metric: m }).value.metric, m);
    assert.equal(validateList({}).value.metric, undefined, "no card = cards only");
    assert.equal(validateList({ metric: "" }).value.metric, undefined);
    assert.ok(validateList({ metric: "REVENUE" }).error);
  });
  it("rejects unknown values", () => {
    for (const q of [{ range: "last-week" }, { section: "ALL-ORDERS" }, { source: "FACEBOOK" }, { paymentStatus: "PAID" }, { fulfilment: "DONE" }, { from: "yesterday" }]) assert.ok(validateFilters(q).error, JSON.stringify(q));
  });
});

describe("website scope and abandoned-checkout request validation", () => {
  it("the Website Orders scope is accepted, anything else is refused", () => {
    assert.equal(validateList({ scope: "WEBSITE" }).value.scope, "WEBSITE");
    assert.equal(validateList({}).value.scope, undefined);
    assert.ok(validateList({ scope: "TELECALLER" }).error);
  });
  it("abandoned cards: the nine breakdowns that exist; COD and prepaid list the converted checkouts and their linked order, never an unrelated card; an unknown card or page size is refused", () => {
    assert.deepEqual([...ABANDONED_METRICS], ["TOTAL", "VALUE", "PENDING", "DONE", "RECOVERED", "CONVERTED", "DETECTED", "COD", "PREPAID"]);
    for (const m of ABANDONED_METRICS) assert.equal(validateAbandonedList({ metric: m }).value.metric, m);
    for (const bad of [{ metric: "PAID" }, { metric: "FULFILLED" }, { pageSize: "1000" }, { page: "0" }, { range: "week" }]) assert.ok(validateAbandonedList(bad).error, JSON.stringify(bad));
    assert.equal(validateAbandonedList({}).value.metric, undefined, "no card = cards only");
    assert.equal(validateAbandonedFilters({ search: " ab " }).value.search, "ab");
    assert.deepEqual([validateAbandonedList({}).value.page, validateAbandonedList({}).value.pageSize], [1, 25]);
  });
  it("follow-up classification: a bought cart is Recovered, never Pending / Completed; otherwise a finished action means Completed", () => {
    assert.deepEqual([followUpOf("RECOVERED", true), followUpOf("RECOVERED", false), followUpOf("ACTIVE", true), followUpOf("IN_PROGRESS", false), followUpOf("NOT_RECOVERED", false)], ["RECOVERED", "RECOVERED", "DONE", "PENDING", "PENDING"]);
  });
  it("the recovered card is the only one that includes bought carts", () => {
    const json = (m: (typeof ABANDONED_METRICS)[number]) => JSON.stringify(abandonedMetricWhere(m));
    for (const m of ["TOTAL", "PENDING", "DONE"] as const) assert.match(json(m), /"not":"RECOVERED"/, m);
    assert.match(json("RECOVERED"), /"status":"RECOVERED"/);
    assert.match(json("VALUE"), /ACTIVE.*IN_PROGRESS/);
  });
});

// ------------------------------------------------------------------------------------------------ date presets, coverage, comparison, chart buckets
import { previousRange } from "./orders.dashboard.range.js";
import { bucketStart, bucketsFor, compare, coverageOf, pctChange, verifiedCoverage } from "./orders.dashboard.insights.js";

describe("date presets (business timezone)", () => {
  const range = (kind: string, now: string) => {
    const r = resolveDashboardRange({ range: kind as never }, new Date(now), IST);
    return [r.from, r.to, r.days] as const;
  };
  // Monday 26 Oct 2026, 11:30 IST
  const MON = "2026-10-26T06:00:00Z";
  it("every preset, relative to today in IST", () => {
    assert.deepEqual(range("today", MON), ["2026-10-26", "2026-10-26", 1]);
    assert.deepEqual(range("yesterday", MON), ["2026-10-25", "2026-10-25", 1]);
    assert.deepEqual(range("this_week", MON), ["2026-10-26", "2026-10-26", 1], "Monday through today");
    assert.deepEqual(range("this_week", "2026-10-29T06:00:00Z"), ["2026-10-26", "2026-10-29", 4]);
    assert.deepEqual(range("this_week", "2026-11-01T06:00:00Z"), ["2026-10-26", "2026-11-01", 7], "Sunday is the last day of the ISO week");
    assert.deepEqual(range("last_7_days", MON), ["2026-10-20", "2026-10-26", 7], "the 7 days ending today");
    assert.deepEqual(range("last_30_days", MON), ["2026-09-27", "2026-10-26", 30]);
    assert.deepEqual(range("this_month", MON), ["2026-10-01", "2026-10-26", 26]);
    assert.deepEqual(range("last_month", MON), ["2026-09-01", "2026-09-30", 30]);
  });
  it("month and year boundaries", () => {
    assert.deepEqual(range("last_month", "2026-11-01T06:00:00Z"), ["2026-10-01", "2026-10-31", 31]);
    assert.deepEqual(range("last_month", "2026-01-05T06:00:00Z"), ["2025-12-01", "2025-12-31", 31]);
    assert.deepEqual(range("last_month", "2026-03-10T06:00:00Z"), ["2026-02-01", "2026-02-28", 28]);
    assert.deepEqual(range("this_month", "2026-11-01T06:00:00Z"), ["2026-11-01", "2026-11-01", 1]);
    assert.deepEqual(range("last_7_days", "2026-01-03T06:00:00Z"), ["2025-12-28", "2026-01-03", 7]);
  });
  it("presets follow the IST date, not the UTC date: 00:10 IST on the 1st is still the 31st in UTC", () => {
    assert.deepEqual(range("this_month", "2026-10-31T18:40:00Z"), ["2026-11-01", "2026-11-01", 1]);
    assert.deepEqual(range("yesterday", "2026-10-31T18:40:00Z"), ["2026-10-31", "2026-10-31", 1]);
  });
  it("the instants: a multi-day preset runs from 00:00 IST of its first day to 00:00 IST after its last", () => {
    const r = resolveDashboardRange({ range: "last_7_days" }, new Date(MON), IST);
    assert.equal(r.start.toISOString(), "2026-10-19T18:30:00.000Z");
    assert.equal(r.end.toISOString(), "2026-10-26T18:30:00.000Z");
  });
  it("the previous period is the same number of days immediately before", () => {
    const p = previousRange(resolveDashboardRange({ range: "last_7_days" }, new Date(MON), IST), IST);
    assert.deepEqual([p.from, p.to, p.days], ["2026-10-13", "2026-10-19", 7]);
    const y = previousRange(resolveDashboardRange({}, new Date(MON), IST), IST);
    assert.deepEqual([y.from, y.to], ["2026-10-24", "2026-10-24"]);
  });
  it("the request validators accept every preset", () => {
    for (const k of ["today", "yesterday", "this_week", "last_7_days", "last_30_days", "this_month", "last_month", "custom"]) {
      assert.equal(validateList({ range: k }).error, null, k);
      assert.equal(validateAbandonedList({ range: k }).error, null, k);
    }
    assert.ok(validateList({ range: "last_year" }).error);
  });
});

describe("coverage: unavailable is never a real zero", () => {
  const day = (d: string) => ({ start: new Date(`${d}T00:00:00Z`), end: new Date(`${d}T23:59:59Z`) });
  it("the period is NONE when the data stops before it, PARTIAL when the data stops inside it, FULL when it spans it", () => {
    const oldest = new Date("2026-09-01T00:00:00Z");
    assert.equal(coverageOf(day("2026-10-25"), oldest, new Date("2026-10-07T12:45:00Z")), "NONE");
    assert.equal(coverageOf(day("2026-10-07"), oldest, new Date("2026-10-07T12:45:00Z")), "PARTIAL");
    assert.equal(coverageOf(day("2026-10-06"), oldest, new Date("2026-10-07T12:45:00Z")), "FULL");
    assert.equal(coverageOf(day("2026-10-06"), null, null), "NONE", "nothing held at all");
    assert.equal(coverageOf(day("2026-08-30"), oldest, new Date("2026-10-07T12:45:00Z")), "NONE", "before the first record");
    assert.equal(coverageOf({ start: new Date("2026-08-30T00:00:00Z"), end: new Date("2026-09-02T00:00:00Z") }, oldest, new Date("2026-10-07T00:00:00Z")), "PARTIAL");
  });
  it("a live feed (a webhook received after the period ended) turns a quiet day into a genuine zero", () => {
    const oldest = new Date("2026-09-01T00:00:00Z");
    assert.equal(coverageOf(day("2026-10-25"), oldest, new Date("2026-10-07T12:45:00Z"), new Date("2026-10-26T01:00:00Z")), "FULL");
    assert.equal(coverageOf(day("2026-10-25"), oldest, new Date("2026-10-07T12:45:00Z"), new Date("2026-10-07T12:50:00Z")), "NONE");
  });
  it("comparison text exists only when both periods are fully covered; a zero baseline gives no percentage", () => {
    assert.deepEqual(compare(150, 100, "FULL", "FULL"), { previous: 100, changePct: 50 });
    assert.deepEqual(compare(50, 100, "FULL", "FULL"), { previous: 100, changePct: -50 });
    assert.deepEqual(compare(5, 0, "FULL", "FULL"), { previous: 0, changePct: null });
    for (const [a, b] of [["FULL", "PARTIAL"], ["PARTIAL", "FULL"], ["NONE", "FULL"], ["FULL", "NONE"]] as const) assert.equal(compare(1, 1, a, b), null);
    assert.equal(pctChange(133, 100), 33);
    assert.equal(pctChange(1, 3), -66.7);
  });
});

describe("chart buckets", () => {
  it("daily: one bucket per day, in order", () => {
    assert.deepEqual(bucketsFor({ from: "2026-10-24", to: "2026-10-26" }, "daily").map((b) => b.key), ["2026-10-24", "2026-10-25", "2026-10-26"]);
  });
  it("weekly: ISO weeks (Monday start), clipped to the range", () => {
    const b = bucketsFor({ from: "2026-10-22", to: "2026-11-03" }, "weekly");
    assert.deepEqual(b.map((x) => [x.key, x.from, x.to]), [["2026-10-19", "2026-10-22", "2026-10-25"], ["2026-10-26", "2026-10-26", "2026-11-01"], ["2026-11-02", "2026-11-02", "2026-11-03"]]);
    assert.equal(bucketStart("2026-10-25", "weekly"), "2026-10-19", "Sunday belongs to the week that began the Monday before");
  });
  it("monthly: calendar months across a year end, clipped", () => {
    const b = bucketsFor({ from: "2025-12-15", to: "2026-02-10" }, "monthly");
    assert.deepEqual(b.map((x) => [x.key, x.from, x.to]), [["2025-12-01", "2025-12-15", "2025-12-31"], ["2026-01-01", "2026-01-01", "2026-01-31"], ["2026-02-01", "2026-02-01", "2026-02-10"]]);
  });
});

describe("verifiedCoverage (the CRM's count checked against Shopify's own)", () => {
  it("Shopify says zero: a genuine zero, complete", () => {
    assert.equal(verifiedCoverage(0, 0, "PARTIAL"), "FULL");
  });
  it("Shopify has orders and the CRM holds none: NONE, never a zero - even when the first/last-record check says FULL (a gap in the middle)", () => {
    assert.equal(verifiedCoverage(0, 40, "FULL"), "NONE");
  });
  it("complete only from 98% of Shopify's count; below that PARTIAL", () => {
    assert.equal(verifiedCoverage(98, 100, "PARTIAL"), "FULL");
    assert.equal(verifiedCoverage(97, 100, "FULL"), "PARTIAL");
    assert.equal(verifiedCoverage(274, 8910, "FULL"), "PARTIAL");
  });
  it("Shopify not reachable: cannot prove completeness, so FULL is capped at PARTIAL; NONE/PARTIAL stay", () => {
    assert.equal(verifiedCoverage(5, null, "FULL"), "PARTIAL");
    assert.equal(verifiedCoverage(0, null, "NONE"), "NONE");
    assert.equal(verifiedCoverage(3, null, "PARTIAL"), "PARTIAL");
  });
});
