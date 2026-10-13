// Distribution dashboard (admin / manager / HR), the telecaller's own summary, and the typed drill-down URLs.
// Run with: ../backend/node_modules/.bin/tsx --test components/abandonment/lead-distribution.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { LeadDistributionView } from "./lead-distribution-dashboard";
import { TelecallerSummaryView } from "./telecaller-lead-summary";
import { abandonedLeadsHref, parseAbandonedLeadsUrl } from "@/lib/abandoned-leads-href";
import type { AbandonmentDistribution, TelecallerSummary } from "@/lib/api-client/types/abandonment.types";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const Z = "33333333-3333-4333-8333-333333333333";
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const hrefOf = (html: string, testId: string) => new RegExp(`<a[^>]*data-testid="${testId}"[^>]*>|<a[^>]*href="[^"]*"[^>]*data-testid="${testId}"`).exec(html)?.[0]?.match(/href="([^"]*)"/)?.[1]?.replace(/&amp;/g, "&");

const data = (over: Partial<AbandonmentDistribution["summary"]> = {}): AbandonmentDistribution => ({
  range: "today", timezone: "IST (UTC+05:30)",
  summary: { total: 10, assigned: 7, unassigned: 3, telecallersWithLeads: 2, todayTotal: 10, yesterdayTotal: 6, unassignedAllTime: 5, ...over },
  telecallers: [
    { userId: A, name: "Asha", totalAssigned: 9, inPeriod: 5, todayAbandoned: 5, yesterdayAbandoned: 3, assignedToday: 2, assignedInPeriod: 2 },
    { userId: B, name: "Bela", totalAssigned: 4, inPeriod: 2, todayAbandoned: 2, yesterdayAbandoned: 0, assignedToday: 0, assignedInPeriod: 0 },
    { userId: Z, name: "Zed Zero", totalAssigned: 0, inPeriod: 0, todayAbandoned: 0, yesterdayAbandoned: 0, assignedToday: 0, assignedInPeriod: 0 },
  ],
});
const view = (d: AbandonmentDistribution, over: { range?: "today" | "yesterday" | "all" } = {}) => renderToStaticMarkup(<LeadDistributionView data={d} range={over.range ?? d.range} />);

describe("distribution dashboard", () => {
  it("shows the six summary cards with their values", () => {
    const h = view(data());
    const v = (id: string) => text(new RegExp(`data-testid="${id}-value"[^>]*>([^<]*)<`).exec(h)?.[1] ?? "?");
    assert.deepEqual(["card-total", "card-assigned", "card-unassigned", "card-telecallers", "card-today", "card-yesterday"].map(v), ["10", "7", "3", "2", "10", "6"]);
    const t = text(h);
    for (const label of ["Total leads today", "Assigned to a telecaller", "Unassigned", "Telecallers with leads", "Today's leads", "Yesterday's leads"]) assert.ok(t.includes(label), label);
  });

  it("lists EVERY telecaller, including one with zero leads", () => {
    const h = view(data());
    assert.ok(h.includes(`telecaller-row-${Z}`));
    assert.match(text(h), /Zed Zero/);
    assert.equal(text(new RegExp(`data-testid="total-${Z}"[^>]*>([^<]*)<`).exec(h)?.[1] ?? ""), "0");
    assert.equal(hrefOf(h, `total-${Z}`), undefined, "a zero count is plain text, not a link to an empty list");
  });

  it("drill-down links carry the right typed filters", () => {
    const h = view(data());
    assert.equal(hrefOf(h, "card-total"), "/dashboard/abandoned-leads");
    assert.equal(hrefOf(h, "card-unassigned"), "/dashboard/abandoned-leads?assignment=UNASSIGNED_TELECALLER");
    assert.equal(hrefOf(h, "card-today"), "/dashboard/abandoned-leads");
    assert.equal(hrefOf(h, "card-yesterday"), "/dashboard/abandoned-leads?range=yesterday");
    assert.equal(hrefOf(h, `total-${A}`), `/dashboard/abandoned-leads?range=all&salespersonId=${A}`);
    assert.equal(hrefOf(h, `today-${A}`), `/dashboard/abandoned-leads?salespersonId=${A}`);
    assert.equal(hrefOf(h, `yesterday-${A}`), `/dashboard/abandoned-leads?range=yesterday&salespersonId=${A}`);
    assert.equal(hrefOf(h, `details-${B}`), `/dashboard/abandoned-leads?salespersonId=${B}`);
    assert.equal(hrefOf(view(data({}), { range: "yesterday" }), `period-${A}`), `/dashboard/abandoned-leads?range=yesterday&salespersonId=${A}`, "the period column follows the selected period");
    assert.equal(hrefOf(view(data({}), { range: "all" }), "card-unassigned"), "/dashboard/abandoned-leads?range=all&assignment=UNASSIGNED_TELECALLER");
  });

  it("makes unassigned work prominent: a banner with the standing backlog, linking to the unassigned list", () => {
    const h = view(data());
    assert.match(text(h), /5 abandoned leads are still waiting for a telecaller/);
    assert.equal(hrefOf(h, "unassigned-banner"), "/dashboard/abandoned-leads?range=all&assignment=UNASSIGNED_TELECALLER");
    assert.ok(!view(data({ unassignedAllTime: 0 })).includes("unassigned-banner"), "no banner when nothing is waiting");
    assert.match(text(view(data({ unassignedAllTime: 1 }))), /1 abandoned lead is still waiting/);
  });

  it("labels each measure so abandon-date and assignment-date counts are never confused", () => {
    const t = text(view(data()));
    for (const s of ["Total assigned currently", "by abandon date", "abandoned today", "abandoned yesterday", "Assigned today by assignment time"]) assert.ok(t.includes(s), s);
    assert.match(text(new RegExp('data-testid="distribution-legend"[^>]*>(.*?)</p>', "s").exec(view(data()))?.[1] ?? ""), /India time/);
  });

  it("every telecaller row has a 'View details' link to that telecaller's filtered list (the list is what HR may open; lead pages are not)", () => {
    const h = view(data());
    for (const id of [A, B, Z]) assert.ok(h.includes(`details-${id}`), id);
  });

  it("an empty team shows a useful empty state", () => {
    const h = view({ ...data(), telecallers: [] });
    assert.match(text(h), /No telecallers to show yet\./);
  });
});

describe("telecaller's own summary", () => {
  const s: TelecallerSummary = { timezone: "IST (UTC+05:30)", totalAssigned: 9, today: 5, yesterday: 3, all: 9, newlyAssignedToday: 2 };
  const h = renderToStaticMarkup(<TelecallerSummaryView data={s} />);
  const v = (id: string) => text(new RegExp(`data-testid="${id}-value"[^>]*>([^<]*)<`).exec(h)?.[1] ?? "?");

  it("shows total assigned, today, yesterday, all and newly assigned today", () => {
    assert.deepEqual(["my-total", "my-today", "my-yesterday", "my-all", "my-new"].map(v), ["9", "5", "3", "9", "2"]);
  });

  it("every card opens the telecaller's OWN list with the matching date filter - never naming a person", () => {
    assert.equal(hrefOf(h, "my-today"), "/dashboard/abandoned-leads");
    assert.equal(hrefOf(h, "my-yesterday"), "/dashboard/abandoned-leads?range=yesterday");
    assert.equal(hrefOf(h, "my-all"), "/dashboard/abandoned-leads?range=all");
    for (const id of ["my-total", "my-today", "my-yesterday", "my-all", "my-new"]) assert.ok(!(hrefOf(h, id) ?? "").includes("salespersonId"), id);
  });

  it("says unassigned leads are not part of the workload", () => {
    assert.match(text(h), /leads waiting for a telecaller are never part of your workload/);
  });
});

describe("typed drill-down URL", () => {
  it("round-trips range, telecaller and unassigned; defaults are omitted", () => {
    assert.equal(abandonedLeadsHref(), "/dashboard/abandoned-leads");
    assert.equal(abandonedLeadsHref({ range: "today" }), "/dashboard/abandoned-leads");
    const p = new URLSearchParams(abandonedLeadsHref({ range: "yesterday", salespersonId: A }).split("?")[1]);
    assert.deepEqual(parseAbandonedLeadsUrl(p), { range: "yesterday", salespersonId: A, assignment: undefined });
    assert.deepEqual(parseAbandonedLeadsUrl(new URLSearchParams("range=all&assignment=UNASSIGNED_TELECALLER")), { range: "all", salespersonId: undefined, assignment: "UNASSIGNED_TELECALLER" });
  });

  it("a hand-edited URL is not trusted: bad range -> Today, non-UUID telecaller dropped, unknown assignment dropped, a named telecaller wins over 'unassigned'", () => {
    assert.deepEqual(parseAbandonedLeadsUrl(new URLSearchParams("range=week&salespersonId=not-a-uuid&assignment=ASSIGNED")), { range: "today", salespersonId: undefined, assignment: undefined });
    assert.equal(parseAbandonedLeadsUrl(new URLSearchParams(`salespersonId=${A}&assignment=UNASSIGNED_TELECALLER`)).assignment, undefined);
    assert.equal(abandonedLeadsHref({ salespersonId: "<script>" }), "/dashboard/abandoned-leads", "the builder refuses a non-UUID too");
  });
});
