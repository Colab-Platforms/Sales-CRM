import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectedTemplateStatus, SUMMARY_KIND_LABEL, SUMMARY_TEMPLATE_MAPPING, SUMMARY_TEMPLATE_NAME, summaryTemplateStatus } from "./report-automation.summary-template.js";
import { SHOPIFY_SUMMARY_VARIABLES, STRUCTURED_TEMPLATE_VARIABLES } from "./report-automation.template-metrics.js";

const T = (over: Partial<{ name: string; provider: string; language: string; status: string; variables: unknown }> = {}) => ({ name: SUMMARY_TEMPLATE_NAME, provider: "META", language: "en", status: "APPROVED", variables: [...SHOPIFY_SUMMARY_VARIABLES], ...over });
const OLD = { name: "aayushwellness_daily_team_report_1", provider: "META", language: "en", status: "APPROVED", variables: [...STRUCTURED_TEMPLATE_VARIABLES] };

describe("the template and its five-variable mapping", () => {
  it("is aayushwellness_daily_team_report_3 and maps {{1}}..{{5}} in order to the named variables", () => {
    assert.equal(SUMMARY_TEMPLATE_NAME, "aayushwellness_daily_team_report_3");
    assert.deepEqual(SUMMARY_TEMPLATE_MAPPING.map((m) => [m.position, m.variable]), [[1, "report_date"], [2, "total_shopify_orders"], [3, "website_orders"], [4, "telecaller_orders"], [5, "total_revenue"]]);
    assert.match(SUMMARY_TEMPLATE_MAPPING[1]!.meaning, /website \+ telecaller/);
    assert.match(SUMMARY_TEMPLATE_MAPPING[4]!.meaning, /revenue/i);
  });
});

describe("configuration status of the Shopify Orders Summary template", () => {
  it("not in the CRM yet: NOT_ADDED with what to do (submit in Meta, then sync)", () => {
    const s = summaryTemplateStatus([OLD], { name: OLD.name, language: "en" });
    assert.deepEqual([s.state, s.status, s.selected], ["NOT_ADDED", null, false]);
    assert.match(s.reason, /not in the CRM yet/);
    assert.match(s.reason, /Sync templates/);
    assert.equal(s.mapping.length, 5);
  });

  it("in the CRM but not approved: NOT_APPROVED for each Meta status, with its own explanation, and never READY", () => {
    for (const [status, text] of [["PENDING", /waiting for approval/], ["REJECTED", /Rejected by Meta/], ["DISABLED", /Disabled/], ["DRAFT", /draft/]] as const) {
      const s = summaryTemplateStatus([T({ status })], null);
      assert.deepEqual([s.state, s.status], ["NOT_APPROVED", status]);
      assert.match(s.reason, text);
    }
    assert.match(summaryTemplateStatus([T({ status: "PENDING" })], { name: OLD.name, language: "en" }).reason, /selected now keeps being used/, "another template is selected: it keeps being used");
  });

  it("when the pending template IS the selected one, it does not claim another template keeps being used - it says reports cannot be sent", () => {
    const s = summaryTemplateStatus([T({ status: "PENDING" })], { name: SUMMARY_TEMPLATE_NAME, language: "en" });
    assert.equal(s.selected, true);
    assert.match(s.reason, /scheduled reports cannot be sent/);
    assert.doesNotMatch(s.reason, /keeps being used/);
  });

  it("approved with exactly the five variables: READY; the order Meta stored them in does not matter", () => {
    const s = summaryTemplateStatus([T({ variables: [...SHOPIFY_SUMMARY_VARIABLES].reverse() })], { name: OLD.name, language: "en" });
    assert.deepEqual([s.state, s.status, s.provider, s.language, s.selected], ["READY", "APPROVED", "META", "en", false]);
    assert.match(s.reason, /Select it and Save/);
  });

  it("READY and selected: says the first message is the Shopify Orders Summary", () => {
    const s = summaryTemplateStatus([T()], { name: SUMMARY_TEMPLATE_NAME, language: "en" });
    assert.deepEqual([s.state, s.selected], ["READY", true]);
    assert.match(s.reason, /Approved and selected/);
  });

  it("approved but with the wrong variables: VARIABLES_MISMATCH naming what it has and what is needed", () => {
    const ten = summaryTemplateStatus([T({ variables: [...STRUCTURED_TEMPLATE_VARIABLES] })], null);
    assert.equal(ten.state, "VARIABLES_MISMATCH");
    assert.match(ten.reason, /total_shopify_orders/);
    const one = summaryTemplateStatus([T({ variables: ["report_text"] })], null);
    assert.equal(one.state, "VARIABLES_MISMATCH");
    assert.match(one.reason, /report_text/);
    const four = summaryTemplateStatus([T({ variables: SHOPIFY_SUMMARY_VARIABLES.slice(0, 4) })], null);
    assert.equal(four.state, "VARIABLES_MISMATCH");
  });

  it("an over-long variable name is explained (Meta's 20-character limit), not hidden", () => {
    const s = summaryTemplateStatus([T({ variables: ["report_date", "total_shopify_orders_summary_x", "website_orders", "telecaller_orders", "total_revenue"] })], null);
    assert.equal(s.state, "VARIABLES_MISMATCH");
    assert.match(s.reason, /20 characters/);
  });

  it("several rows: an approved, correct one wins over a pending one, and Meta over another provider", () => {
    assert.equal(summaryTemplateStatus([T({ status: "PENDING", language: "hi" }), T({ language: "en" })], null).state, "READY");
    const s = summaryTemplateStatus([T({ provider: "AISENSY" }), T({ provider: "META" })], null);
    assert.equal(s.provider, "META");
  });

  it("it is a function of the synced rows only: other templates never make it ready", () => {
    assert.equal(summaryTemplateStatus([OLD, { ...OLD, name: "daily_team_report1", variables: ["report_text"] }], null).state, "NOT_ADDED");
  });
});

describe("the template selected today", () => {
  it("nothing selected = null", () => assert.equal(selectedTemplateStatus([OLD], { name: null, language: null }), null));

  it("the current approved ten-variable template is usable and sends the Website + Abandoned summary", () => {
    const s = selectedTemplateStatus([OLD, T()], { name: OLD.name, language: "en" })!;
    assert.deepEqual([s.usable, s.reason, s.sends], [true, null, "WEBSITE_ABANDONED"]);
    assert.match(SUMMARY_KIND_LABEL[s.sends], /Website Orders \+ Abandoned/);
  });

  it("the approved _3 is usable and sends the Shopify Orders Summary", () => {
    const s = selectedTemplateStatus([T()], { name: SUMMARY_TEMPLATE_NAME, language: "en" })!;
    assert.deepEqual([s.usable, s.sends], [true, "SHOPIFY_SUMMARY"]);
  });

  it("_3 selected while Meta has not approved it: NOT usable, with the reason - flagged before a scheduled send can fail", () => {
    const s = selectedTemplateStatus([T({ status: "PENDING" })], { name: SUMMARY_TEMPLATE_NAME, language: "en" })!;
    assert.equal(s.usable, false);
    assert.match(s.reason ?? "", /Not approved/);
    assert.match(s.reason ?? "", /PENDING/);
  });

  it("a selected name that is not in the CRM at all is reported as such", () => {
    const s = selectedTemplateStatus([OLD], { name: SUMMARY_TEMPLATE_NAME, language: "en" })!;
    assert.equal(s.usable, false);
    assert.match(s.reason ?? "", /not in the CRM/);
  });

  it("a one-variable report_text template reports what it sends too", () => {
    const s = selectedTemplateStatus([{ ...OLD, name: "daily_team_report1", variables: ["report_text"] }], { name: "daily_team_report1", language: "en" })!;
    assert.deepEqual([s.usable, s.sends], [true, "REPORT_TEXT"]);
  });
});
