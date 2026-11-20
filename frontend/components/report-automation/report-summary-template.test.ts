import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SelectedTemplateStatus, SummaryTemplateStatus } from "@/lib/api-client/types/report-automation.types";
import { canUseTemplate, KIND_LABEL, selectedTemplateWarning, stateLabel, stateTone } from "./report-summary-template";

const NAME = "aayushwellness_daily_team_report_3";
const mapping = ["report_date", "total_shopify_orders", "website_orders", "telecaller_orders", "total_revenue"].map((variable, i) => ({ position: i + 1, variable, meaning: variable }));
const t = (over: Partial<SummaryTemplateStatus> = {}): SummaryTemplateStatus => ({ name: NAME, state: "READY", status: "APPROVED", language: "en", provider: "META", reason: "", selected: false, mapping, ...over });

describe("template status presentation", () => {
  it("each state has its own plain label and colour; a rejected or disabled template reads as a problem, not as waiting", () => {
    assert.equal(stateLabel(t()), "Approved - ready");
    assert.equal(stateLabel(t({ state: "NOT_APPROVED", status: "PENDING" })), "Waiting for Meta approval");
    assert.equal(stateLabel(t({ state: "NOT_APPROVED", status: "REJECTED" })), "Rejected by Meta");
    assert.equal(stateLabel(t({ state: "NOT_APPROVED", status: "DISABLED" })), "Disabled at Meta");
    assert.equal(stateLabel(t({ state: "NOT_APPROVED", status: "DRAFT" })), "Draft - not submitted");
    assert.equal(stateLabel(t({ state: "NOT_ADDED", status: null })), "Not added yet");
    assert.equal(stateLabel(t({ state: "VARIABLES_MISMATCH" })), "Variables don't match");
    assert.match(stateTone(t()), /green/);
    assert.match(stateTone(t({ state: "NOT_APPROVED", status: "PENDING" })), /amber/);
    assert.match(stateTone(t({ state: "NOT_APPROVED", status: "REJECTED" })), /red/);
    assert.match(stateTone(t({ state: "VARIABLES_MISMATCH" })), /red/);
  });

  it("'Use this template' is offered only when it is READY and not already the form's selection (same name AND language)", () => {
    assert.equal(canUseTemplate(t(), { templateName: "aayushwellness_daily_team_report_1", languageCode: "en" }), true);
    assert.equal(canUseTemplate(t(), { templateName: NAME, languageCode: "en" }), false, "already selected");
    assert.equal(canUseTemplate(t({ language: "hi" }), { templateName: NAME, languageCode: "en" }), true, "same name, other language");
    for (const state of ["NOT_ADDED", "NOT_APPROVED", "VARIABLES_MISMATCH"] as const) assert.equal(canUseTemplate(t({ state }), { templateName: "x", languageCode: "en" }), false, state);
    assert.equal(canUseTemplate(t({ language: null }), { templateName: "x", languageCode: "en" }), false);
  });

  it("works with the name Meta actually gave the template (aayushwellness_daily_team_report_3_3): offered until it is the form's selection", () => {
    const real = t({ name: "aayushwellness_daily_team_report_3_3" });
    assert.equal(canUseTemplate(real, { templateName: "aayushwellness_daily_team_report_1", languageCode: "en" }), true);
    assert.equal(canUseTemplate(real, { templateName: "aayushwellness_daily_team_report_3_3", languageCode: "en" }), false);
    assert.equal(canUseTemplate(real, { templateName: "aayushwellness_daily_team_report_3", languageCode: "en" }), true, "the older _3 name is a different template");
  });
});

describe("what the saved template sends, and the warning if it cannot be sent", () => {
  const sel = (over: Partial<SelectedTemplateStatus> = {}): SelectedTemplateStatus => ({ name: NAME, language: "en", usable: true, reason: null, sends: "SHOPIFY_SUMMARY", ...over });
  it("a usable (or absent) selection raises no warning", () => {
    assert.equal(selectedTemplateWarning(sel()), null);
    assert.equal(selectedTemplateWarning(null), null);
  });
  it("an unusable selection is called out with its reason and the consequence", () => {
    const w = selectedTemplateWarning(sel({ usable: false, reason: "Not approved by the provider yet (status PENDING)" }))!;
    assert.match(w, /aayushwellness_daily_team_report_3/);
    assert.match(w, /PENDING/);
    assert.match(w, /will fail/);
    assert.match(w, /PENDING\)\. Scheduled/, "a full stop separates the reason from the consequence");
    assert.doesNotMatch(selectedTemplateWarning(sel({ usable: false, reason: "Not found." }))!, /\.\./, "no doubled full stop when the reason already ends with one");
  });
  it("names the summary each kind of template sends", () => {
    assert.match(KIND_LABEL.SHOPIFY_SUMMARY, /Shopify Orders Summary/);
    assert.match(KIND_LABEL.WEBSITE_ABANDONED, /Website Orders \+ Abandoned/);
  });
});
