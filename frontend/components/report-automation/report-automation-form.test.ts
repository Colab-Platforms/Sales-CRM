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
