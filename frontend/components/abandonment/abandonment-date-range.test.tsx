// The Today / Yesterday / All Leads control of the abandoned-leads page.
// Run with: ../backend/node_modules/.bin/tsx --test components/abandonment/abandonment-date-range.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AbandonmentDateRangeFilter, DEFAULT_DATE_RANGE, dateRangeCountText, parseDateRange } from "./abandonment-date-range";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const render = (value: "today" | "yesterday" | "all", total: number | undefined) => renderToStaticMarkup(<AbandonmentDateRangeFilter value={value} onChange={() => {}} total={total} />);
const pressed = (h: string, id: string) => new RegExp(`data-testid="date-range-${id}"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="date-range-${id}"`).test(h);

describe("date range control", () => {
  it("offers exactly Today, Yesterday and All Leads, with Today as the default", () => {
    const t = text(render("today", 3));
    assert.match(t, /Today Yesterday All Leads/);
    assert.equal(DEFAULT_DATE_RANGE, "today");
    assert.equal(parseDateRange(null), "today");
  });

  it("the active choice is clearly marked (aria-pressed) and only that one", () => {
    for (const v of ["today", "yesterday", "all"] as const) {
      const h = render(v, 1);
      for (const other of ["today", "yesterday", "all"]) assert.equal(pressed(h, other), other === v, `${v}: ${other}`);
    }
  });

  it("shows the number of matching leads for the active range (singular/plural, loading)", () => {
    assert.match(text(render("today", 12)), /12 abandoned leads · Today/);
    assert.match(text(render("yesterday", 1)), /1 abandoned lead · Yesterday/);
    assert.match(text(render("all", 0)), /0 abandoned leads in total/);
    assert.match(text(render("today", undefined)), /Loading…/);
    assert.equal(dateRangeCountText("all", 5), "5 abandoned leads in total");
  });

  it("says which timezone days follow (not for All)", () => {
    assert.match(text(render("today", 2)), /days follow India time, IST/);
    assert.doesNotMatch(text(render("all", 2)), /IST/);
  });

  it("an unknown or tampered ?range= falls back to Today (never to an unfiltered, unexpected view)", () => {
    for (const bad of ["week", "TODAY", "", "all,today", "<script>", "undefined"]) assert.equal(parseDateRange(bad), "today", bad);
    for (const ok of ["today", "yesterday", "all"] as const) assert.equal(parseDateRange(ok), ok);
  });
});
