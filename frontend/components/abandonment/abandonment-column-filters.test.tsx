// Run with: ../backend/node_modules/.bin/tsx --test components/abandonment/abandonment-column-filters.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AbandonmentColumnFilter, hasAnyFilter, toApiFilters } from "./abandonment-column-filters";

describe("Abandoned Leads column filters", () => {
  it("hasAnyFilter sees every column filter, including a value of 0", () => {
    assert.equal(hasAnyFilter({}), false);
    for (const f of [{ search: "x" }, { workingStatus: "NEW" as const }, { items: ["a"] }, { lead: "a" }, { contact: "a" }, { assignee: "a" }, { lastAction: "NONE" as const }, { valueMin: 0 }, { valueMax: 10 }, { detectedFrom: "2026-10-01" }, { detectedTo: "2026-10-02" }]) {
      assert.equal(hasAnyFilter(f), true, JSON.stringify(f));
    }
  });

  it("without a custom Detected range the day tab is sent unchanged", () => {
    const q = toApiFilters({ lead: "asha", valueMin: 100 }, "today");
    assert.deepEqual(q, { lead: "asha", valueMin: 100, dateRange: "today" });
  });

  it("a Detected range is sent as IST day bounds and replaces the day tab", () => {
    const q = toApiFilters({ detectedFrom: "2026-10-01", detectedTo: "2026-10-05", contact: "98" }, "yesterday");
    assert.deepEqual(q, { contact: "98", dateRange: "all", dateFrom: "2026-10-01T00:00:00.000+05:30", dateTo: "2026-10-05T23:59:59.999+05:30" });
    assert.equal(new Date(q.dateFrom!).toISOString(), "2026-09-30T18:30:00.000Z");
    assert.deepEqual(toApiFilters({ detectedFrom: "2026-10-01" }, "today"), { dateRange: "all", dateFrom: "2026-10-01T00:00:00.000+05:30" });
  });

  it("every column except Items renders a filter control; unknown columns render nothing", () => {
    for (const column of ["Lead", "Contact", "Value", "Detected", "Lead Status", "Last action", "Assigned to"]) {
      const html = renderToStaticMarkup(<AbandonmentColumnFilter column={column} value={{}} onChange={() => {}} role="ADMIN" />);
      assert.match(html, new RegExp(`aria-label="Filter ${column}"`), column);
    }
    assert.equal(renderToStaticMarkup(<AbandonmentColumnFilter column="Items" value={{}} onChange={() => {}} role="ADMIN" />), "");
  });

  it("an active filter is marked active on its own column only", () => {
    const html = (column: string) => renderToStaticMarkup(<AbandonmentColumnFilter column={column} value={{ valueMin: 100 }} onChange={() => {}} role="ADMIN" />);
    assert.match(html("Value"), /data-active="true"/);
    assert.match(html("Lead"), /data-active="false"/);
  });
});
