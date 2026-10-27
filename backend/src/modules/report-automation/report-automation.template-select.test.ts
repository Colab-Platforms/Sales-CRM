import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyReportTemplates, isReportTemplateName, planTemplateParams } from "./report-automation.sender.js";
import { isStructuredVariableSet, STRUCTURED_TEMPLATE_VARIABLES } from "./report-automation.template-metrics.js";

const tpl = (name: string, status: string, variables: unknown, language = "en", provider = "META") => ({ name, provider, language, status, variables });
const structured = [...STRUCTURED_TEMPLATE_VARIABLES].reverse(); // Meta may store them in any order

// What the CRM stored for aayushwellness_daily_team_report BEFORE the 20-character fix (read from the table): two of these names exceed Meta's limit (Meta answered HTTP 400, code 100).
const OLD_AAYUSH_VARS = ["report_date", "total_orders", "website_revenue", "website_cod_orders", "website_prepaid_orders", "total_leads", "orders_converted", "abandoned_revenue", "abandoned_cod_orders", "abandoned_prepaid_orders"];
// The names after the template is edited in Meta and re-approved (and synced).
const AAYUSH_VARS = ["report_date", "web_total_orders", "web_total_revenue", "web_cod_orders", "web_prepaid_orders", "aband_total_leads", "aband_orders_conv", "aband_revenue", "aband_cod_orders", "aband_prepaid_orders"];

describe("parameter names: Meta's 20-character limit", () => {
  it("every replacement name is at most 20 characters", () => {
    for (const n of STRUCTURED_TEMPLATE_VARIABLES) assert.ok(n.length <= 20, `${n} (${n.length})`);
    assert.deepEqual([...STRUCTURED_TEMPLATE_VARIABLES], AAYUSH_VARS);
  });

  it("a template with an over-long name is unusable, with the exact names and lengths", () => {
    const { usable, unusable } = classifyReportTemplates([tpl("aayushwellness_daily_team_report", "APPROVED", OLD_AAYUSH_VARS)]);
    assert.equal(usable.length, 0);
    assert.match(unusable[0]!.reason, /at most 20 characters/);
    assert.match(unusable[0]!.reason, /"website_prepaid_orders" has 22, "abandoned_prepaid_orders" has 24/);
    assert.match(unusable[0]!.reason, /web_prepaid_orders/);
  });

  it("the sender refuses over-long names BEFORE any send, for both template shapes", async () => {
    let read = false;
    await assert.rejects(planTemplateParams({ name: "aayushwellness_daily_team_report", variables: OLD_AAYUSH_VARS }, "t", async () => { read = true; return {} as any; }), (e: any) => e.name === "ReportSendRejected" && /"website_prepaid_orders" has 22/.test(e.message) && /Nothing was sent/.test(e.message));
    assert.equal(read, false); // not even the figures were loaded
    await assert.rejects(planTemplateParams({ name: "daily_team_report9", variables: ["a_very_long_report_text_name"] }, "t"), /"a_very_long_report_text_name" has 28/);
  });

  it("a name of exactly 20 characters is accepted", async () => {
    assert.equal("aband_prepaid_orders".length, 20);
    const p = await planTemplateParams({ name: "aayushwellness_daily_team_report", variables: AAYUSH_VARS }, "t", async () => Object.fromEntries(AAYUSH_VARS.map((v) => [v, v])) as any);
    assert.equal(p.params.length, 10);
  });
});

describe("regression: aayushwellness_daily_team_report is selectable next to daily_team_report1", () => {
  const stored = [tpl("aayushwellness_daily_team_report", "APPROVED", AAYUSH_VARS), tpl("daily_team_report1", "APPROVED", ["report_text"])];

  it("both appear in the dropdown, with no unusable entries", () => {
    const { usable, unusable } = classifyReportTemplates(stored);
    assert.deepEqual(usable.map((t) => t.name).sort(), ["aayushwellness_daily_team_report", "daily_team_report1"]);
    assert.equal(unusable.length, 0);
  });

  it("the name rule is explicit: only the report family, not arbitrary templates", () => {
    for (const ok of ["daily_team_report", "daily_team_report1", "aayushwellness_daily_team_report", "aayushwellness_daily_team_report2"]) assert.equal(isReportTemplateName(ok), true, ok);
    for (const bad of ["aayushwellness_welcome", "other_daily_team_report", "webinar_feedback_form", "Aayushwellness_daily_team_report", "aayushwellness_daily_team_reportx-y"]) assert.equal(isReportTemplateName(bad), false, bad);
  });

  it("each of Meta's own variable names receives the right figure", async () => {
    const values = Object.fromEntries(STRUCTURED_TEMPLATE_VARIABLES.map((v) => [v, `<${v}>`])) as any;
    const p = await planTemplateParams({ name: "aayushwellness_daily_team_report", variables: AAYUSH_VARS }, "unused", async () => values);
    assert.deepEqual(p.paramNames, AAYUSH_VARS); // sent under the names Meta approved
    assert.deepEqual(p.params, AAYUSH_VARS.map((v) => `<${v}>`));
  });

  it("daily_team_report1 still gets the single text, and never reads the figures", async () => {
    let read = false;
    const p = await planTemplateParams({ name: "daily_team_report1", variables: ["report_text"] }, "the text", async () => { read = true; return {} as any; });
    assert.deepEqual(p, { params: ["the text"], paramNames: ["report_text"] });
    assert.equal(read, false);
  });

  it("ambiguous or partial alias sets are refused", () => {
    const mixed = [...AAYUSH_VARS.slice(0, 9), "total_orders"]; // total_orders and web_total_orders both present, one figure missing
    assert.equal(isStructuredVariableSet(mixed), false);
    assert.equal(isStructuredVariableSet([...AAYUSH_VARS.slice(1), "report_date", "x"]), false);
    assert.equal(isStructuredVariableSet(AAYUSH_VARS), true);
    assert.equal(isStructuredVariableSet(["__proto__", ...AAYUSH_VARS.slice(1)]), false);
  });

  it("a draft or unapproved copy is still not selectable", () => {
    const { usable, unusable } = classifyReportTemplates([tpl("aayushwellness_daily_team_report", "PENDING", AAYUSH_VARS)]);
    assert.equal(usable.length, 0);
    assert.match(unusable[0]!.reason, /Not approved/);
  });
});

describe("which synced templates the report dropdown offers", () => {
  it("keeps the existing report_text template selectable", () => {
    const { usable } = classifyReportTemplates([tpl("daily_team_report1", "APPROVED", ["report_text"])]);
    assert.deepEqual(usable, [{ name: "daily_team_report1", provider: "META", language: "en", status: "APPROVED" }]);
  });

  it("a newly synced APPROVED structured template appears without any code change", () => {
    const { usable, unusable } = classifyReportTemplates([tpl("daily_team_report1", "APPROVED", ["report_text"]), tpl("daily_team_report_v2", "APPROVED", structured)]);
    assert.deepEqual(usable.map((t) => t.name), ["daily_team_report1", "daily_team_report_v2"]);
    assert.equal(unusable.length, 0);
  });

  it("a draft or pending template is listed with the reason, never selectable", () => {
    for (const status of ["DRAFT", "PENDING", "REJECTED", "DISABLED"]) {
      const { usable, unusable } = classifyReportTemplates([tpl("daily_team_report_v2", status, structured)]);
      assert.equal(usable.length, 0, status);
      assert.match(unusable[0]!.reason, new RegExp(`Not approved by the provider yet \\(status ${status}\\)`));
    }
  });

  it("variable compatibility: nine of the ten, an extra one, or a foreign name is refused with a reason", () => {
    const nine = structured.slice(1);
    for (const vars of [nine, [...structured, "extra"], ["report_date"], ["something_else"]]) {
      const { usable, unusable } = classifyReportTemplates([tpl("daily_team_report_x", "APPROVED", vars)]);
      assert.equal(usable.length, 0);
      assert.match(unusable[0]!.reason, /report_text|variables/);
    }
  });

  it("accepts object-shaped stored variables", () => {
    const { usable } = classifyReportTemplates([tpl("daily_team_report_v2", "APPROVED", structured.map((name) => ({ name })))]);
    assert.equal(usable.length, 1);
  });

  it("only the daily_team_report family is selectable; an unrelated structured template is explained", () => {
    const { usable, unusable } = classifyReportTemplates([tpl("webinar_feedback_form", "APPROVED", ["a", "b"]), tpl("other_report", "APPROVED", structured)]);
    assert.equal(usable.length, 0);
    assert.deepEqual(unusable.map((t) => t.name), ["other_report"]); // unrelated templates are not even listed
    assert.match(unusable[0]!.reason, /name must start with "daily_team_report"/);
  });

  it("language and provider are kept apart: one name in two languages gives two options", () => {
    const { usable } = classifyReportTemplates([tpl("daily_team_report_v2", "APPROVED", structured, "en"), tpl("daily_team_report_v2", "APPROVED", structured, "hi"), tpl("daily_team_report_v2", "APPROVED", structured, "en", "GUPSHUP")]);
    assert.deepEqual(usable.map((t) => `${t.provider}/${t.language}`).sort(), ["GUPSHUP/en", "META/en", "META/hi"]);
    const mixed = classifyReportTemplates([tpl("daily_team_report_v2", "APPROVED", structured, "en"), tpl("daily_team_report_v2", "PENDING", structured, "hi")]);
    assert.deepEqual(mixed.usable.map((t) => t.language), ["en"]);
    assert.deepEqual(mixed.unusable.map((t) => t.language), ["hi"]);
  });
});
