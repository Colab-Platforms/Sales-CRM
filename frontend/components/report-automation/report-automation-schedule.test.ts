import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clock12, dataRangeFor, derivePhase, excelStructure, explainNext, localInstant, maskPhone, nextOccurrence, rangeText, runPhase, shiftDate } from "./report-automation-schedule";

const IST = "Asia/Kolkata";
const form = (over: Partial<{ sendTime: string; timezone: string; reportFor: "TODAY" | "YESTERDAY" | "DATE" | "LAST7DAYS"; dataDate: string | null }> = {}) => ({ sendTime: "09:00", timezone: IST, reportFor: "YESTERDAY" as const, dataDate: null, ...over });

describe("timezone arithmetic", () => {
  it("09:00 on 19 Nov in Asia/Kolkata is 03:30 UTC", () => {
    assert.equal(localInstant("2026-11-19", "09:00", IST).toISOString(), "2026-11-19T03:30:00.000Z");
  });
  it("shiftDate crosses month and year ends", () => {
    assert.equal(shiftDate("2026-12-01", -1), "2026-11-30");
    assert.equal(shiftDate("2027-01-01", -1), "2026-12-31");
  });
});

describe("recurring previous-day report: data date = send date - 1", () => {
  it("19 / 20 / 21 / 22 Nov sends cover 18 / 19 / 20 / 21 Nov", () => {
    for (const [send, data] of [["2026-11-19", "2026-11-18"], ["2026-11-20", "2026-11-19"], ["2026-11-21", "2026-11-20"], ["2026-11-22", "2026-11-21"]] as const) {
      assert.deepEqual(dataRangeFor("YESTERDAY", send), { from: data, to: data });
    }
  });
  it("a stale manually chosen date is ignored unless the legacy fixed-date mode is explicitly used", () => {
    assert.deepEqual(dataRangeFor("YESTERDAY", "2026-11-19", "2026-11-01"), { from: "2026-11-18", to: "2026-11-18" });
    assert.deepEqual(dataRangeFor("DATE", "2026-11-19", "2026-11-01"), { from: "2026-11-01", to: "2026-11-01" });
  });
  it("same-day and previous-7-days modes", () => {
    assert.deepEqual(dataRangeFor("TODAY", "2026-11-19"), { from: "2026-11-19", to: "2026-11-19" });
    assert.deepEqual(dataRangeFor("LAST7DAYS", "2026-11-19"), { from: "2026-11-12", to: "2026-11-18" });
  });
});

describe("next occurrence", () => {
  it("18 Nov 13:30 IST with 09:00 daily: next send is 19 Nov 9:00 AM and it covers 18 Nov", () => {
    const now = new Date("2026-11-18T08:00:00Z");
    const n = nextOccurrence(form(), now)!;
    assert.equal(n.sendDate, "2026-11-19");
    assert.equal(clock12(n.sendAt, IST), "9:00 AM");
    assert.deepEqual(n.data, { from: "2026-11-18", to: "2026-11-18" });
    assert.equal(explainNext(n, IST, now), "This report will be sent tomorrow at 9:00 AM and will contain sales data from today, 18 November 2026.");
  });
  it("changing the time updates the preview: 21:00 has not passed yet today, so it is today and covers 17 Nov", () => {
    const now = new Date("2026-11-18T08:00:00Z");
    const n = nextOccurrence(form({ sendTime: "21:00" }), now)!;
    assert.equal(n.sendDate, "2026-11-18");
    assert.deepEqual(n.data, { from: "2026-11-17", to: "2026-11-17" });
    assert.match(explainNext(n, IST, now), /sent today at 9:00 PM .* from yesterday, 17 November 2026\./);
  });
  it("if today's time has passed, the next valid occurrence is tomorrow (the IST day, not the browser's)", () => {
    // 22:30 IST on 18 Nov is 17:00 UTC: still the 18th in India
    const n = nextOccurrence(form(), new Date("2026-11-18T17:00:00Z"))!;
    assert.equal(n.sendDate, "2026-11-19");
    // 02:00 UTC on 19 Nov is 07:30 IST on the 19th, before 09:00: the send is still today in IST
    const m = nextOccurrence(form(), new Date("2026-11-19T02:00:00Z"))!;
    assert.equal(m.sendDate, "2026-11-19");
    assert.deepEqual(m.data, { from: "2026-11-18", to: "2026-11-18" });
  });
  it("an invalid time gives no preview", () => {
    assert.equal(nextOccurrence(form({ sendTime: "9am" }), new Date()), null);
  });
  it("a multi-day report is explained as a range", () => {
    const now = new Date("2026-11-18T08:00:00Z");
    const n = nextOccurrence(form({ reportFor: "LAST7DAYS" }), now)!;
    assert.equal(rangeText(n.data), "12 Nov 2026 - 18 Nov 2026");
    assert.match(explainNext(n, IST, now), /from 12 November 2026 to 18 November 2026\./);
  });
});

describe("run status for the grouped history", () => {
  const r = (a: string, b: string, c: string) => ({ status: a, detail: { status: b }, document: { status: c } });
  it("all parts accepted = Sent; a mix of accepted and failed = Partially sent; only failures = Failed", () => {
    assert.equal(runPhase({ status: "SENT", recipients: [r("SENT", "SENT", "SENT"), r("SENT", "SENT", "SENT")] }), "SENT");
    assert.equal(runPhase({ status: "FAILED", recipients: [r("SENT", "SENT", "SENT"), r("SENT", "FAILED", "FAILED")] }), "PARTIALLY_SENT");
    assert.equal(runPhase({ status: "FAILED", recipients: [r("FAILED", "FAILED", "FAILED")] }), "FAILED");
  });
  it("waiting for a reply, sending, scheduled and cancelled", () => {
    assert.equal(runPhase({ status: "PENDING", recipients: [r("SENT", "WAITING_FOR_REPLY", "WAITING_FOR_REPLY")] }), "WAITING_FOR_REPLY");
    assert.equal(derivePhase(["SENDING", "PENDING"]), "PROCESSING");
    assert.equal(derivePhase(["PENDING", "PENDING"]), "SCHEDULED");
    assert.equal(runPhase({ status: "CANCELLED", recipients: [] }), "CANCELLED");
    assert.equal(derivePhase(["SKIPPED"]), "SENT");
  });
});

describe("small helpers", () => {
  it("masks a number to its first 3 and last 2 characters", () => {
    assert.equal(maskPhone("+919876543210"), "+91••••••••10");
  });
  it("the Excel structure follows the chosen contents", () => {
    const all = excelStructure({ teamSummary: true, calls: true, leads: true, sales: true, followUps: true });
    assert.deepEqual(all.map((s) => s.sheet), ["Team Summary", "Telecaller Performance"]);
    assert.ok(all[1]!.columns.includes("Revenue") && all[1]!.columns.includes("Talk time (h:mm:ss)"));
    const salesOnly = excelStructure({ teamSummary: true, calls: false, leads: false, sales: true, followUps: false });
    assert.deepEqual(salesOnly[1]!.columns, ["Telecaller", "Orders", "Revenue", "Cancelled orders"]);
  });
});
