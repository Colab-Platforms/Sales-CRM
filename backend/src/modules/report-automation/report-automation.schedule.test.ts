import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivePhase, formatsOf, PHASE_LABEL, upcomingOccurrences, type ScheduleAutomation } from "./report-automation.schedule.js";

const auto = (over: Partial<ScheduleAutomation> = {}): ScheduleAutomation => ({ enabled: true, sendTime: "18:00", timezone: "Asia/Kolkata", reportFor: "YESTERDAY", reportDataDate: null, sendText: true, sendExcel: true, updatedAt: new Date("2026-10-27T00:00:00Z"), ...over });
const now = new Date("2026-10-27T09:00:00Z"); // 14:30 IST on 27 Oct

describe("upcoming occurrences: execution time vs report data date", () => {
  it("the user's example: 6:00 PM IST on 28 Oct covers 27 Oct, kept as separate fields", () => {
    const [o] = upcomingOccurrences(auto({ sendTime: "18:00" }), now, () => false);
    // today's 18:00 IST (12:30Z) is still ahead, so it is the first one
    assert.equal(o!.scheduledAt.toISOString(), "2026-10-27T12:30:00.000Z");
    assert.equal(o!.dataTo, "2026-10-26");
    const tomorrow = upcomingOccurrences(auto(), now, (d) => d === "2026-10-27")[0]!;
    assert.equal(tomorrow.scheduledAt.toISOString(), "2026-10-28T12:30:00.000Z"); // 28 Oct, 6:00 PM IST
    assert.equal(tomorrow.scheduledDate, "2026-10-28");
    assert.equal(tomorrow.dataFrom, "2026-10-27"); // report data date: 27 Oct
    assert.equal(tomorrow.dataTo, "2026-10-27");
    assert.equal(tomorrow.timezone, "Asia/Kolkata");
    assert.equal(tomorrow.utcOffset, "UTC+05:30");
  });
  it("TODAY covers the send day; LAST7DAYS covers the seven complete days before it; DATE is fixed", () => {
    assert.equal(upcomingOccurrences(auto({ reportFor: "TODAY" }), now, () => false)[0]!.dataTo, "2026-10-27");
    const w = upcomingOccurrences(auto({ reportFor: "LAST7DAYS" }), now, () => false)[0]!;
    assert.deepEqual([w.dataFrom, w.dataTo], ["2026-10-20", "2026-10-26"]);
    const d = upcomingOccurrences(auto({ reportFor: "DATE", reportDataDate: "2026-10-10" }), now, () => false, 2);
    assert.deepEqual(d.map((x) => `${x.scheduledDate}->${x.dataTo}`), ["2026-10-27->2026-10-10", "2026-10-28->2026-10-10"]);
  });
  it("a time already passed today is not upcoming; an occurrence that already has a run is not listed again", () => {
    const o = upcomingOccurrences(auto({ sendTime: "09:00" }), now, () => false);
    assert.equal(o[0]!.scheduledDate, "2026-10-28");
    assert.equal(upcomingOccurrences(auto(), now, () => true).length, 0);
  });
  it("another timezone is formatted in its own zone", () => {
    const o = upcomingOccurrences(auto({ timezone: "America/New_York", sendTime: "18:00" }), now, () => false)[0]!;
    assert.equal(o.scheduledAt.toISOString(), "2026-10-27T22:00:00.000Z");
    assert.equal(o.utcOffset, "UTC-04:00");
  });
  it("nothing is upcoming when disabled, when both formats are off, or before the settings were saved", () => {
    assert.equal(upcomingOccurrences(auto({ enabled: false }), now, () => false).length, 0);
    assert.equal(upcomingOccurrences(auto({ sendText: false, sendExcel: false }), now, () => false).length, 0);
    assert.equal(upcomingOccurrences(auto({ updatedAt: new Date("2026-10-28T00:00:00Z") }), now, () => false)[0]!.scheduledDate, "2026-10-28");
  });
  it("delivery formats follow the switches", () => {
    assert.deepEqual(formatsOf({ sendText: true, sendExcel: true }), ["NOTIFICATION", "DETAIL", "EXCEL"]);
    assert.deepEqual(formatsOf({ sendText: false, sendExcel: true }), ["EXCEL"]);
  });
});

describe("status transitions", () => {
  it("upcoming -> processing -> waiting -> partially sent / sent / failed", () => {
    assert.equal(derivePhase(["PENDING", "PENDING", "PENDING"]), "SCHEDULED");
    assert.equal(derivePhase(["SENDING", "PENDING", "PENDING"]), "PROCESSING");
    assert.equal(derivePhase(["SENT", "SENDING", "PENDING"]), "PROCESSING");
    assert.equal(derivePhase(["SENT", "WAITING_FOR_REPLY", "WAITING_FOR_REPLY"]), "WAITING_FOR_REPLY");
    assert.equal(derivePhase(["SENT", "SENT", "FAILED"]), "PARTIALLY_SENT");
    assert.equal(derivePhase(["SENT", "UNCERTAIN", "DELIVERED"]), "PARTIALLY_SENT");
    assert.equal(derivePhase(["SENT", "DELIVERED", "READ"]), "SENT");
    assert.equal(derivePhase(["FAILED", "FAILED", "FAILED"]), "FAILED");
    assert.equal(derivePhase(["FAILED", "UNCERTAIN", "SKIPPED"]), "FAILED");
  });
  it("a part switched off or not needed is ignored", () => {
    assert.equal(derivePhase(["SKIPPED", "READ", "READ"]), "SENT");
    assert.equal(derivePhase(["SKIPPED", "SKIPPED", "SKIPPED"]), "SENT");
  });
  it("every phase has a label", () => assert.equal(PHASE_LABEL.WAITING_FOR_REPLY, "Waiting for recipient reply"));
});

describe("consecutive daily occurrences with cancelled dates", () => {
  const cancelled = new Set(["2026-10-29"]);
  it("skips only the cancelled date; the neighbours stay scheduled (consecutive otherwise)", () => {
    const dates = upcomingOccurrences(auto({ reportFor: "TODAY" }), new Date("2026-10-27T13:00:00Z"), (d) => cancelled.has(d), 4).map((o) => o.scheduledDate);
    assert.deepEqual(dates, ["2026-10-28", "2026-10-30", "2026-10-31", "2026-11-01"]);
  });
  it("Asia/Kolkata date boundary: 00:30 IST is the previous UTC day but the occurrence date is the IST date", () => {
    const o = upcomingOccurrences(auto({ sendTime: "00:30", reportFor: "TODAY" }), new Date("2026-10-27T17:00:00Z"), () => false, 2); // 22:30 IST on 27 Oct
    assert.deepEqual(o.map((x) => x.scheduledDate), ["2026-10-28", "2026-10-29"]);
    assert.equal(o[0]!.scheduledAt.toISOString(), "2026-10-27T19:00:00.000Z");
  });
});
