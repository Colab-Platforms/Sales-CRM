import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ReportSnapshot } from "@/lib/api-client/types/report-automation.types";
import { compareSnapshots, formatDelta, formatMetric, metricByKey, SNAPSHOT_METRICS } from "./report-snapshots";

const base = (figures: ReportSnapshot["figures"]): ReportSnapshot => ({ id: "s", runId: "r", kind: "SCHEDULED", reportDate: "2026-11-18", reportFrom: "2026-11-18", timezone: "Asia/Kolkata", templateName: "t", generatedAt: "2026-11-19T03:30:00Z", values: {}, runStatus: "SENT", deliveries: [], figures });
/** An older snapshot: website + abandoned figures only. */
const legacy = (conv: number, rev: number, other?: number): ReportSnapshot => base({ website: { totalOrders: 78, totalRevenue: 48372, codOrders: 3, prepaidOrders: 74, ...(other === undefined ? {} : { otherOrders: other }) }, abandoned: { totalLeads: 442, ordersConverted: conv, revenue: rev, codOrders: conv - 8, prepaidOrders: 8 } });
/** A Shopify Orders Summary snapshot. */
const shopify = (total: number, web: number, tele: number, revenue: number): ReportSnapshot => base({ shopify: { totalOrders: total, websiteOrders: web, telecallerOrders: tele, totalRevenue: revenue }, website: { totalOrders: web, totalRevenue: 69000.05, codOrders: 5, prepaidOrders: 115, otherOrders: 0 }, abandoned: null });

describe("snapshot comparison", () => {
  it("shows both exact figures and the difference, metric by metric (09:00 vs later)", () => {
    const rows = compareSnapshots(legacy(32, 20793, 1), legacy(43, 27744, 1));
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.deepEqual([by.ab_converted!.left, by.ab_converted!.right, by.ab_converted!.delta], [32, 43, 11]);
    assert.deepEqual([by.ab_revenue!.left, by.ab_revenue!.right, by.ab_revenue!.delta], [20793, 27744, 6951]);
    assert.equal(by.web_total!.delta, 0);
    assert.equal(rows.length, SNAPSHOT_METRICS.length);
  });
  it("a snapshot taken before 'other payment' existed has no figure for it: '-' and no delta, never a made-up zero", () => {
    const other = compareSnapshots(legacy(32, 20793), legacy(32, 20793, 1)).find((r) => r.key === "web_other")!;
    assert.deepEqual([other.left, other.right, other.delta], [null, 1, null]);
    assert.equal(formatMetric(other.left, false), "-");
    assert.equal(formatDelta(other.delta, false), "-");
  });
  it("formatting: rupees with Indian grouping, signed deltas, 'same' for no change", () => {
    assert.equal(formatMetric(27744, true), "₹27,744");
    assert.equal(formatDelta(6951, true), "+₹6,951");
    assert.equal(formatDelta(-101, true), "-₹101");
    assert.equal(formatDelta(0, false), "same");
  });
});

describe("Shopify Orders Summary snapshot: 204 / 120 / 84 / ₹1,27,581.05", () => {
  const s = shopify(204, 120, 84, 127581.05);
  it("reads the four figures exactly as stored; the total revenue keeps its paise", () => {
    const v = (k: string) => metricByKey(k).read(s);
    assert.deepEqual([v("sh_total"), v("sh_website"), v("sh_telecaller"), v("sh_revenue")], [204, 120, 84, 127581.05]);
    const m = metricByKey("sh_revenue");
    assert.equal(formatMetric(m.read(s), m.money, m.exact), "₹1,27,581.05");
    assert.equal(formatMetric(12000, true, true), "₹12,000.00");
  });
  it("total = website + telecaller-created in the stored figures", () => {
    assert.equal(metricByKey("sh_total").read(s), metricByKey("sh_website").read(s)! + metricByKey("sh_telecaller").read(s)!);
  });
  it("an older snapshot has no Shopify figures: '-' in every Shopify field, and no delta against a new one", () => {
    const old = legacy(32, 20793);
    assert.deepEqual(["sh_total", "sh_website", "sh_telecaller", "sh_revenue"].map((k) => metricByKey(k).read(old)), [null, null, null, null]);
    const rows = compareSnapshots(old, s);
    assert.ok(rows.filter((r) => r.key.startsWith("sh_")).every((r) => r.delta === null && r.left === null && r.right !== null));
  });
  it("a snapshot that did not read the abandoned section shows '-' for it (not 0)", () => {
    assert.equal(metricByKey("ab_converted").read(s), null);
    assert.equal(metricByKey("web_total").read(s), 120);
  });
  it("two Shopify snapshots compare to the paisa", () => {
    const rows = compareSnapshots(s, shopify(230, 130, 100, 150000.5));
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.deepEqual([by.sh_total!.delta, by.sh_telecaller!.delta, by.sh_revenue!.delta], [26, 16, 22419.45]);
    assert.equal(formatDelta(by.sh_revenue!.delta, true, true), "+₹22,419.45");
  });
});
