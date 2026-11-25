import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStructuredValues, isShopifySummarySet, isStructuredVariableSet, SHOPIFY_SUMMARY_VARIABLES, STRUCTURED_TEMPLATE_VARIABLES, UNAVAILABLE, type StructuredNeed } from "./report-automation.template-metrics.js";
import { classifyReportTemplates, evaluateReportTemplate, planTemplateParams, ReportSendRejected } from "./report-automation.sender.js";
import { periodLabel } from "./report-automation.report.js";

const full = {
  website: { totalOrders: 19, totalRevenue: 133033.4, codOrders: 12, prepaidOrders: 7 },
  abandoned: { totalLeads: 274, ordersConverted: 29, revenue: 48000.6, codOrders: 20, prepaidOrders: 9 },
};

describe("telecaller slot: only the successful telecaller orders, as a plain number", () => {
  const base = { website: null, abandoned: null };
  it("shows just '66' (no total, no brackets) when the successful count is known, and the stored total for older frozen figures", () => {
    const withOk = buildStructuredValues("22 Nov 2026", { ...base, shopify: { totalOrders: 187, websiteOrders: 117, telecallerOrders: 70, telecallerSuccessfulOrders: 66, totalRevenue: 125122 } });
    assert.deepEqual([withOk.total_shopify_orders, withOk.website_orders, withOk.telecaller_orders, withOk.total_revenue], ["187", "117", "66", "1,25,122.00"]);
    const old = buildStructuredValues("22 Nov 2026", { ...base, shopify: { totalOrders: 187, websiteOrders: 117, telecallerOrders: 70, totalRevenue: 125122 } });
    assert.equal(old.telecaller_orders, "70");
    for (const [ok, shown] of [[66, "66"], [53, "53"], [87, "87"], [0, "0"]] as const) {
      const v = buildStructuredValues("x", { ...base, shopify: { totalOrders: 200, websiteOrders: 100, telecallerOrders: 100, telecallerSuccessfulOrders: ok, totalRevenue: 1 } });
      assert.equal(v.telecaller_orders, shown);
      assert.ok(!/[()]/.test(v.telecaller_orders), "no brackets");
    }
  });
  it("an unreadable Shopify section stays N/A, never a made-up 0", () => {
    assert.equal(buildStructuredValues("22 Nov 2026", { ...base, shopify: null }).telecaller_orders, "N/A");
  });
  it("the value is one line with no tab or newline (Meta rejects those in a parameter)", () => {
    const v = buildStructuredValues("22 Nov 2026", { ...base, shopify: { totalOrders: 5, websiteOrders: 1, telecallerOrders: 4, telecallerSuccessfulOrders: 3, totalRevenue: 1 } });
    assert.ok(!/[\n\t\r]/.test(v.telecaller_orders));
  });
});

describe("structured notification template - the figures", () => {
  it("maps each of the ten variables to its dashboard figure; revenue is whole rupees with Indian grouping and no currency sign (the template text has the rupee sign)", () => {
    assert.deepEqual(buildStructuredValues("26 Oct 2026", full), {
      report_date: "26 Oct 2026",
      web_total_orders: "19",
      web_total_revenue: "1,33,033",
      web_cod_orders: "12",
      web_prepaid_orders: "7",
      web_other_orders: "N/A", // this fixture has no otherOrders figure: never a made-up zero
      aband_total_leads: "274",
      aband_orders_conv: "29",
      aband_revenue: "48,001",
      aband_cod_orders: "20",
      aband_prepaid_orders: "9",
      // the Shopify Orders Summary figures: this fixture has no Shopify section, so they are N/A (never a made-up zero)
      total_shopify_orders: "N/A",
      website_orders: "N/A",
      telecaller_orders: "N/A",
      total_revenue: "N/A",
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

describe("optional web_other_orders (Other Payment Orders)", () => {
  const eleven = { name: "aayushwellness_daily_team_report_2", variables: [...STRUCTURED_TEMPLATE_VARIABLES, "web_other_orders"] };
  it("the ten (as already approved) and the ten plus web_other_orders are both accepted; any other extra is not", () => {
    assert.equal(isStructuredVariableSet(STRUCTURED_TEMPLATE_VARIABLES), true);
    assert.equal(isStructuredVariableSet(eleven.variables), true);
    assert.equal(isStructuredVariableSet([...eleven.variables].reverse()), true, "any order");
    assert.equal(isStructuredVariableSet([...eleven.variables, "extra"]), false);
    assert.equal(isStructuredVariableSet([...STRUCTURED_TEMPLATE_VARIABLES.slice(1), "web_other_orders"]), false, "ten variables that miss a required figure");
  });
  it("a real zero is 0, the count is the dashboard's other-payment figure, and the eleven are matched BY NAME", async () => {
    const withOther = { ...full, website: { ...full.website, otherOrders: 0 } };
    assert.equal(buildStructuredValues("26 Oct 2026", withOther).web_other_orders, "0");
    const v = buildStructuredValues("18 Nov 2026", { ...full, website: { ...full.website, otherOrders: 1 } });
    const plan = await planTemplateParams(eleven, "x", async () => v);
    assert.equal(plan.params[plan.paramNames.indexOf("web_other_orders")], "1");
    assert.equal(plan.params.length, 11);
    assert.equal(evaluateReportTemplate({ ...eleven, status: "APPROVED" }).ok, true);
  });
  it("the name fits Meta's 20-character limit", () => assert.ok("web_other_orders".length <= 20));
});

// ---------------------------------------------------------------------------------------------- "Shopify Orders Summary" (aayushwellness_daily_team_report_3)
describe("Shopify Orders Summary template: 204 / 120 / 84 / 1,27,581.05", () => {
  const shopify = { totalOrders: 204, websiteOrders: 120, telecallerOrders: 84, totalRevenue: 127581.05 };
  const metrics = { website: { totalOrders: 120, totalRevenue: 69000.05, codOrders: 5, prepaidOrders: 115, otherOrders: 0 }, abandoned: null, shopify };
  // the five variables as Meta stores them for the approved template, in body order ({{1}} .. {{5}})
  const stored = [...SHOPIFY_SUMMARY_VARIABLES];
  const tpl = { name: "aayushwellness_daily_team_report_3", variables: stored };

  it("maps {{1}}..{{5}}: report date, total Shopify orders, website orders, telecaller-created orders, total revenue (with paise, Indian grouping, no rupee sign)", () => {
    const v = buildStructuredValues("19 Nov 2026", metrics);
    assert.deepEqual(SHOPIFY_SUMMARY_VARIABLES.map((n) => v[n]), ["19 Nov 2026", "204", "120", "84", "1,27,581.05"]);
  });

  it("total = website + telecaller-created, and the figures are the same ones the dashboard shows (website 120)", () => {
    const v = buildStructuredValues("19 Nov 2026", metrics);
    assert.equal(Number(v.total_shopify_orders), Number(v.website_orders) + Number(v.telecaller_orders));
    assert.equal(v.website_orders, String(metrics.website.totalOrders));
  });

  it("revenue keeps two decimals even for a whole amount, and a real zero is 0 / 0.00 - never N/A", () => {
    assert.equal(buildStructuredValues("d", { ...metrics, shopify: { ...shopify, totalRevenue: 50000 } }).total_revenue, "50,000.00");
    const zero = buildStructuredValues("d", { ...metrics, shopify: { totalOrders: 0, websiteOrders: 0, telecallerOrders: 0, totalRevenue: 0 } });
    assert.deepEqual([zero.total_shopify_orders, zero.website_orders, zero.telecaller_orders, zero.total_revenue], ["0", "0", "0", "0.00"]);
  });

  it("an unreadable Shopify section is N/A in all four figures - never a made-up zero", () => {
    const v = buildStructuredValues("d", { ...metrics, shopify: null });
    assert.deepEqual([v.total_shopify_orders, v.website_orders, v.telecaller_orders, v.total_revenue], [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]);
    assert.equal(buildStructuredValues("d", { website: null, abandoned: null }).total_revenue, UNAVAILABLE, "metrics built before this section existed");
  });

  it("the variable names fit Meta's 20 characters and are exactly five, distinct from the old ten", () => {
    assert.equal(SHOPIFY_SUMMARY_VARIABLES.length, 5);
    for (const n of SHOPIFY_SUMMARY_VARIABLES) assert.ok(n.length <= 20, `${n} (${n.length})`);
    assert.equal(SHOPIFY_SUMMARY_VARIABLES.filter((n) => (STRUCTURED_TEMPLATE_VARIABLES as readonly string[]).includes(n)).length, 1, "only report_date is shared");
  });

  it("the template shape is accepted in any stored order; extra, missing or mixed variables are not; the old shapes are untouched", () => {
    assert.equal(isShopifySummarySet(stored), true);
    assert.equal(isShopifySummarySet([...stored].reverse()), true);
    assert.equal(isShopifySummarySet([...stored, "extra"]), false);
    assert.equal(isShopifySummarySet(stored.slice(1)), false);
    assert.equal(isShopifySummarySet([...stored.slice(0, 4), "web_total_orders"]), false);
    assert.equal(isShopifySummarySet(STRUCTURED_TEMPLATE_VARIABLES), false);
    assert.equal(isStructuredVariableSet(stored), false, "the old shape check does not accept the new one");
    assert.equal(isStructuredVariableSet(STRUCTURED_TEMPLATE_VARIABLES), true);
  });

  it("the sender gets the values BY NAME in the template's own order, and asks for the Shopify figures only", async () => {
    const v = buildStructuredValues("19 Nov 2026", metrics);
    let asked: StructuredNeed | undefined;
    const plan = await planTemplateParams({ ...tpl, variables: [...stored].reverse() }, "x", async (need) => { asked = need; return v; });
    assert.deepEqual(asked, { shopify: true });
    assert.deepEqual(plan.paramNames, [...stored].reverse());
    assert.deepEqual(plan.params, ["1,27,581.05", "84", "120", "204", "19 Nov 2026"]);
    assert.equal(plan.params.length, 5, "no abandoned or website-revenue figure is sent");
  });

  it("the original ten-variable template still asks for the original figures and is unaffected", async () => {
    const v = buildStructuredValues("19 Nov 2026", { ...metrics, abandoned: { totalLeads: 538, ordersConverted: 54, revenue: 36634, codOrders: 36, prepaidOrders: 18 } });
    let asked: StructuredNeed | undefined;
    const plan = await planTemplateParams({ name: "aayushwellness_daily_team_report_1", variables: [...STRUCTURED_TEMPLATE_VARIABLES] }, "x", async (need) => { asked = need; return v; });
    assert.deepEqual(asked, { legacy: true });
    assert.equal(plan.params.length, 10);
    assert.equal(plan.params[1], "120");
  });

  it("it needs the figures: without them the send is refused with nothing sent", async () => {
    await assert.rejects(() => planTemplateParams(tpl, "x"), /Shopify order figures, which were not provided/);
  });

  it("the template is accepted when APPROVED and listed as usable; a pending one is not", () => {
    assert.deepEqual(evaluateReportTemplate({ ...tpl, status: "APPROVED" }), { ok: true });
    assert.equal(evaluateReportTemplate({ ...tpl, status: "PENDING" }).ok, false);
    const c = classifyReportTemplates([{ ...tpl, provider: "META", language: "en", status: "APPROVED" }]);
    assert.deepEqual(c.usable.map((t) => t.name), ["aayushwellness_daily_team_report_3"]);
  });
});
