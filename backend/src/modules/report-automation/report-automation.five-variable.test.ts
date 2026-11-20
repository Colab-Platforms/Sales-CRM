// The five-variable Shopify Orders Summary template, exactly as registered in Meta: aayushwellness_daily_team_report_3_3 (Meta adds a suffix when a name is reused).
//   1 report_date -> Report date | 2 total_shopify_orders -> All Shopify orders | 3 website_orders -> Website orders | 4 telecaller_orders -> Telecaller-created orders | 5 total_revenue -> Revenue across all Shopify orders
// Validation, mapping and sending are tested together here, and the existing 1-variable and 10-variable templates are checked to be untouched.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyReportTemplates, evaluateReportTemplate, isReportTemplateName, planTemplateParams, ReportSendRejected, reportCompatibility } from "./report-automation.sender.js";
import { buildStructuredValues, isShopifySummarySet, isStructuredVariableSet, SHOPIFY_SUMMARY_VARIABLES, STRUCTURED_TEMPLATE_VARIABLES, type StructuredNeed, type TemplateMetrics } from "./report-automation.template-metrics.js";
import { isSummaryTemplateName, summaryTemplateStatus } from "./report-automation.summary-template.js";

const NAME = "aayushwellness_daily_team_report_3_3";
const FIVE = ["report_date", "total_shopify_orders", "website_orders", "telecaller_orders", "total_revenue"];
const row = (over: Partial<{ name: string; provider: string; language: string; status: string; variables: unknown }> = {}) => ({ name: NAME, provider: "META", language: "en", status: "APPROVED", variables: FIVE, ...over });
const METRICS: TemplateMetrics = { website: { totalOrders: 120, totalRevenue: 69000.05, codOrders: 5, prepaidOrders: 115, otherOrders: 0 }, abandoned: null, shopify: { totalOrders: 204, websiteOrders: 120, telecallerOrders: 84, totalRevenue: 127581.05 } };

describe("validation: exactly the five variables", () => {
  it("the five names are exactly the ones specified, in the specified order", () => {
    assert.deepEqual([...SHOPIFY_SUMMARY_VARIABLES], FIVE);
  });

  it("the template name with Meta's suffix is a report template, accepted by every check the sender and the Add Template picker use", () => {
    assert.equal(isReportTemplateName(NAME), true);
    assert.deepEqual(evaluateReportTemplate(row()), { ok: true });
    assert.deepEqual(reportCompatibility({ name: NAME, variables: FIVE }), { ok: true });
    const c = classifyReportTemplates([row()]);
    assert.deepEqual([c.usable.map((t) => t.name), c.unusable.length], [[NAME], 0]);
  });

  it("variables as Meta's sync may store them - plain names or objects with a name - in any order", () => {
    assert.equal(isShopifySummarySet(FIVE), true);
    assert.equal(isShopifySummarySet([...FIVE].reverse()), true);
    assert.deepEqual(evaluateReportTemplate(row({ variables: FIVE.map((name) => ({ name, example: "x" })) })), { ok: true });
    assert.deepEqual(evaluateReportTemplate(row({ variables: [...FIVE].reverse() })), { ok: true });
  });

  it("anything that is not exactly these five is refused: four, six, a wrong or misspelled name, a duplicate, a mix with the old ten, or positional numbers", () => {
    const bad: [string, unknown][] = [
      ["four", FIVE.slice(0, 4)],
      ["six", [...FIVE, "extra"]],
      ["one wrong name", [...FIVE.slice(0, 4), "total_revenues"]],
      ["a duplicate instead of a name", [...FIVE.slice(0, 4), "website_orders"]],
      ["mixed with the old ten", [...FIVE.slice(0, 4), "web_total_orders"]],
      ["positional", ["1", "2", "3", "4", "5"]],
      ["none", []],
    ];
    for (const [label, variables] of bad) {
      assert.equal(isShopifySummarySet(variables as string[]), false, label);
      assert.equal(evaluateReportTemplate(row({ variables })).ok, false, label);
      assert.equal(classifyReportTemplates([row({ variables })]).usable.length, 0, label);
    }
    const reason = (evaluateReportTemplate(row({ variables: FIVE.slice(0, 4) })) as { reason: string }).reason;
    assert.match(reason, /4 variables/);
    assert.match(reason, /total_shopify_orders/, "the message names the five that are accepted");
  });

  it("a template that is not approved is listed with its reason and is never usable", () => {
    for (const status of ["PENDING", "REJECTED", "DISABLED", "DRAFT"]) {
      const c = classifyReportTemplates([row({ status })]);
      assert.equal(c.usable.length, 0, status);
      assert.match(c.unusable[0]!.reason, /Not approved/, status);
    }
  });

  it("the existing 1-variable and 10-variable templates are exactly as before", () => {
    assert.deepEqual(evaluateReportTemplate({ name: "daily_team_report1", status: "APPROVED", variables: ["report_text"] }), { ok: true });
    assert.deepEqual(evaluateReportTemplate({ name: "aayushwellness_daily_team_report_1", status: "APPROVED", variables: [...STRUCTURED_TEMPLATE_VARIABLES] }), { ok: true });
    assert.deepEqual(evaluateReportTemplate({ name: "aayushwellness_daily_team_report_2", status: "APPROVED", variables: [...STRUCTURED_TEMPLATE_VARIABLES, "web_other_orders"] }), { ok: true });
    assert.equal(isStructuredVariableSet(FIVE), false, "the five are not mistaken for the ten");
    assert.equal(isShopifySummarySet([...STRUCTURED_TEMPLATE_VARIABLES]), false);
    assert.equal(evaluateReportTemplate({ name: "daily_team_report1", status: "APPROVED", variables: ["wrong_name"] }).ok, false);
    assert.equal(evaluateReportTemplate({ name: "daily_team_report1", status: "APPROVED", variables: ["a", "b"] }).ok, false);
  });
});

describe("mapping: each variable carries its own figure", () => {
  const values = buildStructuredValues("19 Nov 2026", METRICS);

  it("fills the five by NAME from the Shopify summary figures (204 / 120 / 84 / 1,27,581.05), whatever order Meta stored them in", async () => {
    let asked: StructuredNeed | undefined;
    const plan = await planTemplateParams(row(), "x", async (need) => { asked = need; return values; });
    assert.deepEqual(asked, { shopify: true });
    assert.deepEqual(plan.paramNames, FIVE);
    assert.deepEqual(plan.params, ["19 Nov 2026", "204", "120", "84", "1,27,581.05"]);
    const shuffled = [FIVE[4]!, FIVE[1]!, FIVE[0]!, FIVE[3]!, FIVE[2]!];
    const p2 = await planTemplateParams(row({ variables: shuffled }), "x", async () => values);
    assert.deepEqual(Object.fromEntries(p2.paramNames.map((n, i) => [n, p2.params[i]])), { report_date: "19 Nov 2026", total_shopify_orders: "204", website_orders: "120", telecaller_orders: "84", total_revenue: "1,27,581.05" });
  });

  it("total = website + telecaller-created, and nothing else is sent (no old website / abandoned figure)", async () => {
    const plan = await planTemplateParams(row(), "x", async () => values);
    assert.equal(Number(plan.params[1]), Number(plan.params[2]) + Number(plan.params[3]));
    assert.equal(plan.params.length, 5);
    assert.ok(!plan.paramNames.some((n) => n.startsWith("web_") || n.startsWith("aband_")));
  });

  it("without the figures nothing is sent; an unreadable Shopify section is N/A in all four figures, never a zero", async () => {
    await assert.rejects(() => planTemplateParams(row(), "x"), (e: unknown) => e instanceof ReportSendRejected && /Shopify order figures, which were not provided/.test((e as Error).message));
    const na = await planTemplateParams(row(), "x", async () => buildStructuredValues("19 Nov 2026", { ...METRICS, shopify: null }));
    assert.deepEqual(na.params, ["19 Nov 2026", "N/A", "N/A", "N/A", "N/A"]);
  });

  it("a wrong template is refused BEFORE any figure is read: the figures callback is never called", async () => {
    let called = false;
    await assert.rejects(() => planTemplateParams(row({ variables: FIVE.slice(0, 4) }), "x", async () => { called = true; return values; }), ReportSendRejected);
    assert.equal(called, false);
  });

  it("the old templates still ask for their own figures and send exactly what they did", async () => {
    let asked: StructuredNeed | undefined;
    const ten = await planTemplateParams({ name: "aayushwellness_daily_team_report_1", variables: [...STRUCTURED_TEMPLATE_VARIABLES] }, "x", async (need) => { asked = need; return values; });
    assert.deepEqual(asked, { legacy: true });
    assert.equal(ten.params.length, 10);
    const one = await planTemplateParams({ name: "daily_team_report1", variables: ["report_text"] }, "the one-line text", async () => { throw new Error("must not be read"); });
    assert.deepEqual([one.paramNames, one.params], [["report_text"], ["the one-line text"]]);
  });
});

describe("the card recognises the template under the name Meta gave it", () => {
  it("the _3 family, with or without Meta's suffix, is the summary template; look-alikes are not", () => {
    for (const n of ["aayushwellness_daily_team_report_3", "aayushwellness_daily_team_report_3_3", "aayushwellness_daily_team_report_3_v2"]) assert.equal(isSummaryTemplateName(n), true, n);
    for (const n of ["aayushwellness_daily_team_report_30", "aayushwellness_daily_team_report_1", "aayushwellness_daily_team_report_2", "daily_team_report_3", "aayushwellness_daily_team_report"]) assert.equal(isSummaryTemplateName(n), false, n);
  });

  it("_3_3 approved with the five variables: READY under ITS OWN name (not 'not added'), and selected when it is the saved one", () => {
    const s = summaryTemplateStatus([row()], { name: NAME, language: "en" });
    assert.deepEqual([s.name, s.state, s.status, s.selected], [NAME, "READY", "APPROVED", true]);
    assert.equal(summaryTemplateStatus([row()], { name: "aayushwellness_daily_team_report_1", language: "en" }).selected, false);
  });

  it("an older pending _3 beside the approved _3_3: the usable one wins; with nothing approved the pending one is shown", () => {
    assert.equal(summaryTemplateStatus([row({ name: "aayushwellness_daily_team_report_3", status: "PENDING" }), row()], null).name, NAME);
    const s = summaryTemplateStatus([row({ status: "PENDING" })], null);
    assert.deepEqual([s.name, s.state], [NAME, "NOT_APPROVED"]);
  });

  it("an approved _3_3 with the wrong variables is a variables mismatch under its own name; another report template with exactly the five variables is recognised by its variables", () => {
    assert.deepEqual((({ name, state }) => ({ name, state }))(summaryTemplateStatus([row({ variables: FIVE.slice(0, 4) })], null)), { name: NAME, state: "VARIABLES_MISMATCH" });
    const other = summaryTemplateStatus([row({ name: "daily_team_report_summary" })], null);
    assert.deepEqual([other.name, other.state], ["daily_team_report_summary", "READY"]);
    assert.equal(summaryTemplateStatus([row({ name: "random_five_vars" })], null).state, "NOT_ADDED", "a name outside the report family is never picked up");
  });
});
