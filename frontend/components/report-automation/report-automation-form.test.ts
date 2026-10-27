// Run with: ../backend/node_modules/.bin/tsx --test components/report-automation/report-automation-form.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeRecipient, validateForm, validateRecipients, STATUS_LABEL, REPORT_MODE_LABEL } from "./report-automation-form";
import { NAV_BY_ROLE } from "../app-sidebar";

const ok = { enabled: true, recipients: [{ name: "Owner", phone: "+91 98765 43210" }, { phone: "+14155550123" }], sendTime: "21:00", timezone: "Asia/Kolkata", reportFor: "TODAY" as const, dataDate: null as string | null, templateName: "daily_team_report", languageCode: "en_GB", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true }, includedUserIds: [], sendText: true, sendExcel: true };

describe("report automation form", () => {
  it("accepts a complete configuration and normalises the number the way the server does", () => {
    assert.deepEqual(validateForm(ok), {});
    assert.equal(normalizeRecipient(ok.recipients[0]!.phone), "+919876543210");
  });
  it("flags a bad number, a missing country code, a duplicate (after normalising), too many, and none when enabling; a disabled draft may be empty", () => {
    assert.match(validateRecipients([{ phone: "9876543210" }], true)["0"] ?? "", /country code/);
    assert.match(validateRecipients([{ phone: "" }], true)["0"] ?? "", /Enter/);
    assert.match(validateRecipients([{ phone: "+919876543210" }, { phone: "+91 98765-43210" }], true)["1"] ?? "", /already/);
    assert.match(validateRecipients(Array.from({ length: 11 }, (_, i) => ({ phone: `+9198765432${String(i).padStart(2, "0")}` })), true).list ?? "", /At most 10/);
    assert.match(validateRecipients([], true).list ?? "", /At least one/);
    assert.deepEqual(validateRecipients([], false), {});
  });
  it("shows a message for a bad time, missing template or empty metric selection", () => {
    assert.match(validateForm({ ...ok, sendTime: "9pm" }).sendTime ?? "", /24-hour/);
    assert.match(validateForm({ ...ok, templateName: " " }).templateName ?? "", /required/);
    assert.match(validateForm({ ...ok, options: { ...ok.options, calls: false, leads: false, sales: false, followUps: false } }).options ?? "", /at least one/);
    assert.match(validateForm({ ...ok, recipients: [] }).recipients ?? "", /At least one/);
    assert.deepEqual(validateForm({ ...ok, enabled: false, recipients: [], templateName: "" }), {});
  });
  it("the data date option: Today / Yesterday / Previous 7 days need nothing more; a specific date needs a real calendar day", () => {
    for (const reportFor of ["TODAY", "YESTERDAY", "LAST7DAYS"] as const) assert.deepEqual(validateForm({ ...ok, reportFor }), {}, reportFor);
    assert.match(validateForm({ ...ok, reportFor: "DATE", dataDate: null }).dataDate ?? "", /Select the date/);
    assert.match(validateForm({ ...ok, reportFor: "DATE", dataDate: "2026-02-30" }).dataDate ?? "", /Select the date/);
    assert.match(validateForm({ ...ok, reportFor: "DATE", dataDate: "15/09/2026" }).dataDate ?? "", /Select the date/);
    assert.deepEqual(validateForm({ ...ok, reportFor: "DATE", dataDate: "2026-09-15" }), {});
    assert.deepEqual(Object.keys(REPORT_MODE_LABEL), ["TODAY", "YESTERDAY", "DATE", "LAST7DAYS"]);
  });
  it("the text and the Excel can each be switched off, but not both; the dedicated template is required for the text", () => {
    assert.deepEqual(validateForm({ ...ok, sendText: false, templateName: "" }), {}, "Excel only needs no template");
    assert.match(validateForm({ ...ok, sendText: false, sendExcel: false }).sendText ?? "", /text message, the Excel file, or both/);
    assert.match(validateForm({ ...ok, templateName: "" }).templateName ?? "", /daily_team_report/);
  });
  it("labels never call an accepted message delivered: only DELIVERED / READ (provider callbacks) say so", () => {
    assert.equal(STATUS_LABEL.SENT, "Accepted by WhatsApp");
    assert.deepEqual(Object.entries(STATUS_LABEL).filter(([, l]) => /delivered/i.test(l)).map(([k]) => k), ["DELIVERED"]);
    assert.equal(STATUS_LABEL.SKIPPED, "Not sent (not needed / turned off)");
    assert.equal(STATUS_LABEL.UNCERTAIN, "Outcome unknown");
  });
  it("the navigation item exists for ADMIN and MANAGER only", () => {
    const has = (role: keyof typeof NAV_BY_ROLE) => JSON.stringify(NAV_BY_ROLE[role]).includes("/dashboard/report-automation");
    assert.deepEqual([has("ADMIN"), has("MANAGER"), has("SALESPERSON"), has("HR"), has("RECRUITER")], [true, true, false, false, false]);
  });
});

import { syncMessage } from "./report-automation-form";
describe("syncMessage", () => {
  const base = { supported: true, created: 1, updated: 0, unchanged: 2, disabledMissing: 0, total: 3 };
  it("reports counts and that only APPROVED templates are selectable", () => {
    const m = syncMessage(base);
    assert.equal(m.ok, true);
    assert.match(m.text, /Synced 3 templates from Meta: 1 new, 0 updated, 2 unchanged/);
    assert.match(m.text, /Only APPROVED/);
  });
  it("mentions templates no longer at Meta", () => assert.match(syncMessage({ ...base, disabledMissing: 2 }).text, /2 no longer at Meta/));
  it("explains the limitation when listing is unsupported and changes nothing", () => {
    const m = syncMessage({ ...base, supported: false, reason: "No Meta config", created: 0, unchanged: 0, total: 0 });
    assert.equal(m.ok, false);
    assert.match(m.text, /not available: No Meta config/);
    assert.match(m.text, /Nothing was changed/);
  });
});

import { pickerErrorMessage, pickerKey, pickerRowState, syncFailureMessage } from "./report-automation-form";
describe("Add Template picker", () => {
  it("keys a row by name AND language", () => assert.notEqual(pickerKey({ name: "daily_team_report2", language: "en" }), pickerKey({ name: "daily_team_report2", language: "hi" })));
  it("shows Add, Already added, or why a template cannot be added", () => {
    assert.equal(pickerRowState({ alreadyAdded: false, compatible: true, incompatibleReason: null }).kind, "add");
    assert.equal(pickerRowState({ alreadyAdded: true, compatible: true, incompatibleReason: null }).kind, "added");
    const b = pickerRowState({ alreadyAdded: false, compatible: false, incompatibleReason: "It has 2 variables" });
    assert.equal(b.kind, "blocked");
    assert.match(b.note ?? "", /cannot use this template: It has 2 variables/);
  });
  it("explains a Meta timeout and a server reason, never offering manual entry", () => {
    const t = pickerErrorMessage({ code: "ECONNABORTED" });
    assert.match(t, /timed out/);
    assert.doesNotMatch(t, /manual/i);
    assert.match(pickerErrorMessage({ response: { data: { message: "Meta WhatsApp Cloud API is not configured" } } }), /not configured. Nothing was changed/);
  });
});
describe("recipient number length", () => {
  it("rejects an Indian number one digit short, accepts the full one", () => {
    assert.match(validateRecipients([{ phone: "+91932614025" }], true)["0"] ?? "", /exactly 10 digits/);
    assert.deepEqual(validateRecipients([{ phone: "+919321614025" }], true), {});
    assert.deepEqual(validateRecipients([{ phone: "+14155550123" }], true), {});
  });
});
describe("syncFailureMessage", () => {
  it("explains a client timeout and points to manual registration", () => {
    const m = syncFailureMessage({ code: "ECONNABORTED", message: "timeout of 20000ms exceeded" });
    assert.match(m, /timed out/);
    assert.match(m, /selection was not changed/);
    assert.match(m, /Add Template/);
  });
  it("treats the server's database timeout the same way", () => assert.match(syncFailureMessage({ response: { data: { message: "Timeout exceeded when trying to connect" } } }), /timed out/));
  it("shows other server reasons", () => assert.match(syncFailureMessage({ response: { data: { message: "Meta WhatsApp Cloud API is not configured" } } }), /not configured.*Add Template/));
});

import { dataRangeLabel, formatInZone } from "./report-automation-form";
describe("Scheduled Reports formatting", () => {
  it("shows the send instant in the configured timezone, not the browser's", () => {
    assert.equal(formatInZone("2026-10-28T12:30:00.000Z", "Asia/Kolkata"), "28 Oct 2026, 6:00 PM IST");
    assert.equal(formatInZone("2026-10-28T12:30:00.000Z", "UTC"), "28 Oct 2026, 12:30 PM UTC");
    assert.match(formatInZone("2026-10-28T22:00:00.000Z", "America/New_York"), /28 Oct 2026, 6:00 PM ET/);
    assert.equal(formatInZone("not a date", "UTC"), "-");
  });
  it("keeps the report data date separate from the execution time", () => {
    assert.equal(dataRangeLabel("2026-10-27", "2026-10-27"), "27 Oct 2026");
    assert.equal(dataRangeLabel("2026-10-20", "2026-10-26"), "20 Oct 2026 - 26 Oct 2026");
    assert.notEqual(formatInZone("2026-10-28T12:30:00.000Z", "Asia/Kolkata").slice(0, 11), dataRangeLabel("2026-10-27", "2026-10-27").slice(0, 11));
  });
});

import { cancelConfirmText, deleteConfirmText, PAUSE_CONFIRM } from "./report-automation-form";
describe("confirmation texts", () => {
  it("cancel names the time and the data date; delete names recipient, date and run type and warns about sent messages", () => {
    assert.match(cancelConfirmText({ scheduledAt: "2026-10-28T12:30:00.000Z", timezone: "Asia/Kolkata", dataFrom: "2026-10-27", dataTo: "2026-10-27" }), /28 Oct 2026, 6:00 PM IST.*data date 27 Oct 2026/);
    const t = deleteConfirmText({ recipientName: "Muzammil", recipientPhone: "+91•••••••25", dataFrom: "2026-10-26", dataTo: "2026-10-26", kind: "TEST", sentAny: true });
    assert.match(t, /test run for Muzammil.*26 Oct 2026/);
    assert.match(t, /cannot recall/);
    assert.doesNotMatch(deleteConfirmText({ recipientName: null, recipientPhone: "x", dataFrom: "2026-10-26", dataTo: "2026-10-26", sentAny: false }), /cannot recall/);
    assert.match(PAUSE_CONFIRM, /not recalled/);
  });
});

import { cancelFailureText, cancelSuccessText } from "./report-automation-form";
describe("cancel messages", () => {
  it("success names the exact date; failure shows the backend reason and does not claim success", () => {
    assert.match(cancelSuccessText({ scheduledAt: "2026-10-29T11:33:00.000Z", timezone: "Asia/Kolkata" }), /Cancelled the report scheduled for 29 Oct 2026, 5:03 PM IST/);
    const f = cancelFailureText({ response: { data: { message: "This report has already started (or finished), so it cannot be cancelled safely." } } });
    assert.match(f, /^Not cancelled: This report has already started/);
    assert.doesNotMatch(f, /^Cancelled/);
    assert.match(cancelFailureText(new Error("Network Error")), /Network Error/);
  });
});
