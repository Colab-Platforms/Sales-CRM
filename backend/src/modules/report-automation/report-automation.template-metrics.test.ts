import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStructuredValues, isStructuredVariableSet, STRUCTURED_TEMPLATE_VARIABLES, UNAVAILABLE } from "./report-automation.template-metrics.js";
import { evaluateReportTemplate, planTemplateParams, ReportSendRejected } from "./report-automation.sender.js";
import { periodLabel } from "./report-automation.report.js";

const full = {
  website: { totalOrders: 19, totalRevenue: 133033.4, codOrders: 12, prepaidOrders: 7 },
  abandoned: { totalLeads: 274, ordersConverted: 29, revenue: 48000.6, codOrders: 20, prepaidOrders: 9 },
};

describe("structured notification template - the figures", () => {
  it("maps each of the ten variables to its dashboard figure; revenue is whole rupees with Indian grouping and no currency sign (the template text has the rupee sign)", () => {
    assert.deepEqual(buildStructuredValues("26 Oct 2026", full), {
      report_date: "26 Oct 2026",
      web_total_orders: "19",
      web_total_revenue: "1,33,033",
      web_cod_orders: "12",
      web_prepaid_orders: "7",
      aband_total_leads: "274",
      aband_orders_conv: "29",
      aband_revenue: "48,001",
      aband_cod_orders: "20",
      aband_prepaid_orders: "9",
    });
  });

  it("a real zero stays 0, but a section that could not be read is N/A in every one of its fields - never a fabricated zero", () => {
    const zero = buildStructuredValues("26 Oct 2026", { website: { totalOrders: 0, totalRevenue: 0, codOrders: 0, prepaidOrders: 0 }, abandoned: null });
    assert.deepEqual([zero.web_total_orders, zero.web_total_revenue], ["0", "0"]);
    assert.deepEqual([zero.aband_total_leads, zero.aband_orders_conv, zero.aband_revenue, zero.aband_cod_orders, zero.aband_prepaid_orders], Array(5).fill(UNAVAILABLE));
    const none = buildStructuredValues("26 Oct 2026", { website: null, abandoned: null });
    assert.ok(Object.entries(none).every(([k, v]) => k === "report_date" || v === UNAVAILABLE));
    assert.equal(buildStructuredValues("26 Oct 2026", { website: { totalOrders: Number.NaN, totalRevenue: -1, codOrders: 1, prepaidOrders: 1 }, abandoned: null }).web_total_orders, UNAVAILABLE);
  });

  it("the report date is the report's own date label (Asia/Kolkata calendar day), and cannot carry line breaks into a template parameter", () => {
    assert.equal(buildStructuredValues(periodLabel({ from: "2026-10-26", to: "2026-10-26" }), full).report_date, "26 Oct 2026");
    assert.equal(buildStructuredValues("26 Oct\n2026\t", full).report_date, "26 Oct 2026");
  });
});

describe("structured notification template - which template shape is accepted", () => {
  const legacy = { name: "daily_team_report1", variables: ["report_text"] };
  const shuffled = { name: "daily_team_report2", variables: [...STRUCTURED_TEMPLATE_VARIABLES].reverse() };
  const values = buildStructuredValues("26 Oct 2026", full);

  it("the CURRENT approved template (one variable {{report_text}}) is used exactly as before: the one-line text, one parameter, the structured figures are never read", async () => {
    let read = false;
    const plan = await planTemplateParams(legacy, "Team report for 26 Oct 2026", async () => { read = true; return values; });
    assert.deepEqual(plan, { params: ["Team report for 26 Oct 2026"], paramNames: ["report_text"] });
    assert.equal(read, false);
    assert.deepEqual(evaluateReportTemplate({ ...legacy, status: "APPROVED" }), { ok: true });
  });

  it("a template that declares the ten variables gets them BY NAME, in the template's own stored order", async () => {
    const plan = await planTemplateParams(shuffled, "ignored", async () => values);
    assert.deepEqual(plan.paramNames, [...STRUCTURED_TEMPLATE_VARIABLES].reverse());
    assert.deepEqual(plan.params, [...STRUCTURED_TEMPLATE_VARIABLES].reverse().map((n) => values[n]));
    assert.deepEqual(evaluateReportTemplate({ ...shuffled, status: "APPROVED" }), { ok: true });
    assert.equal(evaluateReportTemplate({ ...shuffled, status: "PENDING" }).ok, false, "still needs Meta approval");
    assert.equal(isStructuredVariableSet(STRUCTURED_TEMPLATE_VARIABLES), true);
  });

  it("any other shape is refused with the reason and nothing is built: nine of the ten, an extra variable, a wrong single variable, or the figures missing", async () => {
    const nine = { name: "t", variables: STRUCTURED_TEMPLATE_VARIABLES.slice(1) };
    const eleven = { name: "t", variables: [...STRUCTURED_TEMPLATE_VARIABLES, "extra"] };
    for (const t of [nine, eleven, { name: "t", variables: ["something_else"] }, { name: "t", variables: [] }]) {
      await assert.rejects(() => planTemplateParams(t, "x", async () => values), ReportSendRejected);
      assert.equal(evaluateReportTemplate({ ...t, status: "APPROVED" }).ok, false);
    }
    await assert.rejects(() => planTemplateParams(shuffled, "x"), /figures, which were not provided/);
  });
});
