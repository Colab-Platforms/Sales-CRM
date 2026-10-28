// Run with: ../backend/node_modules/.bin/tsx --test components/calling/call-quick-actions.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { callStateLabel, customerLine, fullLeadHref } from "./call-quick-actions";

describe("call popup quick actions helpers", () => {
  it("state label: Ringing until connected, Connected on the call, Call Ended on any terminal status", () => {
    for (const s of ["INITIATED", "RINGING_AGENT", "AGENT_ANSWERED", "RINGING_CUSTOMER"] as const) assert.equal(callStateLabel(s), "Ringing", s);
    assert.equal(callStateLabel(undefined), "Ringing");
    assert.equal(callStateLabel("CONNECTED"), "Connected");
    for (const s of ["COMPLETED", "NO_ANSWER", "BUSY", "NOT_REACHABLE", "FAILED"] as const) assert.equal(callStateLabel(s), "Call Ended", s);
  });
  it("full lead link is for exactly this lead", () => assert.equal(fullLeadHref("abc-123"), "/dashboard/leads/abc-123"));
  it("customer line shows only what is known", () => {
    assert.equal(customerLine({ mobile: "+919876543210", status: "FOLLOW_UP" }), "+919876543210 · FOLLOW UP");
    assert.equal(customerLine({ mobile: null }), "");
  });
});

import { hasUnsavedOutcome, savedSummary } from "./call-quick-actions";
describe("dispositions do not remove or lock anything", () => {
  it("a saved callback / follow-up is not 'unsaved' (closing is allowed, nothing is re-saved) and a later change IS unsaved", () => {
    const stored = { outcomeId: null, notes: null };
    assert.equal(hasUnsavedOutcome({ outcomeId: "cb", notes: "" }, stored, null), true);
    assert.equal(hasUnsavedOutcome({ outcomeId: "cb", notes: "" }, stored, { outcomeId: "cb", notes: "" }), false); // just saved
    assert.equal(hasUnsavedOutcome({ outcomeId: "cb", notes: "now ready to order" }, stored, { outcomeId: "cb", notes: "" }), true); // notes updated later
    assert.equal(hasUnsavedOutcome({ outcomeId: "interested", notes: "" }, { outcomeId: "cb", notes: null }, { outcomeId: "cb", notes: "" }), true); // disposition changed later
    assert.equal(hasUnsavedOutcome({ outcomeId: "", notes: "" }, stored, null), false);
  });
  it("the saved line shows the disposition and its follow-up time, and nothing when none is saved", () => {
    assert.equal(savedSummary("Call back requested", "2026-10-29T12:30:00.000Z", "Asia/Kolkata"), "Saved: Call back requested · follow-up 29 Oct, 6:00 pm");
    assert.equal(savedSummary("Not interested", null), "Saved: Not interested");
    assert.equal(savedSummary(null, null), null);
  });
});
