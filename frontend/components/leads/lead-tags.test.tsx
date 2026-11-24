// Renders the real tag components and the import preview / filters, and asserts what is visible.
// Run with: ../backend/node_modules/.bin/tsx --test components/leads/lead-tags.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LeadTags } from "./lead-tags";
import { PreviewSummary } from "./import-leads-dialog";
import { SegmentClassFilters } from "./lead-filters";
import { SelectAllMatching } from "./select-all-matching";
import { idFilterOf } from "@/lib/lead-filter";
import type { SegmentTag } from "@/lib/api-client/types/lead.types";

const seg = (id: string, name: string, color = "#ff6600"): SegmentTag => ({ id, name, color, isActive: true });
const count = (html: string, token: string) => html.split(token).length - 1;

describe("lead tags", () => {
  it("shows the customer classification and every campaign segment, independently", () => {
    const html = renderToStaticMarkup(<LeadTags customerClass="VIP" segments={[seg("1", "Diwali Mega Sale"), seg("2", "VIP Special Offers", "#0066ff")]} />);
    assert.match(html, /data-class="VIP"/);
    assert.match(html, />VIP</);
    assert.match(html, /Diwali Mega Sale/);
    assert.match(html, /VIP Special Offers/);
    assert.equal(count(html, 'data-testid="segment-tag"'), 2);
    assert.equal(count(html, 'data-testid="customer-class-tag"'), 1);
  });
  it("renders the right label for each classification, and nothing for an unclassified lead with no segments", () => {
    assert.match(renderToStaticMarkup(<LeadTags customerClass="REPEAT" segments={[]} />), />Repeat</);
    assert.match(renderToStaticMarkup(<LeadTags customerClass="LOYAL" segments={[]} />), />Loyal</);
    assert.equal(renderToStaticMarkup(<LeadTags customerClass={null} segments={[]} />), "");
    assert.equal(renderToStaticMarkup(<LeadTags customerClass={undefined} segments={undefined} />), "");
  });
  it("a segment alone, or a classification alone, still shows", () => {
    assert.equal(count(renderToStaticMarkup(<LeadTags customerClass={null} segments={[seg("1", "Only Segment")]} />), 'data-testid="customer-class-tag"'), 0);
    assert.match(renderToStaticMarkup(<LeadTags customerClass={null} segments={[seg("1", "Only Segment")]} />), /Only Segment/);
    assert.match(renderToStaticMarkup(<LeadTags customerClass="LOYAL" segments={[]} />), /Loyal/);
  });
  it("uses each segment's own colour, and ignores a malformed one", () => {
    assert.match(renderToStaticMarkup(<LeadTags segments={[seg("1", "A", "#ff6600")]} />), /#ff6600/);
    const bad = renderToStaticMarkup(<LeadTags segments={[seg("1", "A", "red; background:url(x)")]} />);
    assert.ok(!bad.includes("url(x)"));
  });
});

describe("import preview", () => {
  const preview = { totalRows: 56000, eligibleRows: 54315, invalidRows: 577, newLeads: 54015, missingPhone: 600, missingOrderCount: 12, invalidOrderCount: 3, classification: { repeat: 20000, loyal: 20000, vip: 14315, unclassified: 0 }, problems: [{ row: 5, reason: "No phone number or email" }] };
  it("shows the totals, the chosen segment, duplicates, invalid, missing phone and missing order counts", () => {
    const html = renderToStaticMarkup(<PreviewSummary preview={preview} segment={{ id: "s", name: "Repeat Customers", color: "#0ea5e9", isActive: true, isSystem: true, createdAt: "" }} />);
    for (const text of ["56,000", "54,315", "577", "600", "Repeat Customers", "Row 5: No phone number or email", "20,000 Repeat", "14,315 VIP"]) assert.ok(html.includes(text), text);
  });
  it("says so when no segment is selected", () => {
    assert.match(renderToStaticMarkup(<PreviewSummary preview={preview} segment={null} />), /None selected/);
  });
});

describe("segment and classification filters, and select-all-matching", () => {
  const segments = [{ id: "a", name: "Diwali Mega Sale", color: "#f00", isActive: true, isSystem: false, createdAt: "", counts: { total: 56000, assigned: 40000, unassigned: 16000, withManagerOnly: 0, withSalesperson: 40000 } }];
  it("offers each segment (with its count) and Repeat / Loyal / VIP as two separate filters", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SegmentClassFilters value={{}} onChange={() => undefined} segments={segments} />
      </QueryClientProvider>,
    );
    assert.match(html, /Diwali Mega Sale \(56,000\)/);
    for (const l of ["Repeat", "Loyal", "VIP"]) assert.ok(html.includes(`>${l}<`), l);
    assert.match(html, /id="lead-segment-filter"/);
    assert.match(html, /id="lead-class-filter"/);
  });
  it("the id filter carries only real filters, and is null with none (so 'select everything' is never offered unfiltered)", () => {
    assert.equal(idFilterOf({}), null);
    assert.equal(idFilterOf({ bucket: "TODAY", aiAgent: "ONLY" }), null);
    assert.deepEqual(idFilterOf({ segmentId: "a", customerClass: "VIP", assignment: "UNASSIGNED" }), { segmentId: "a", customerClass: "VIP", assignment: "UNASSIGNED" });
  });
  it("offers 'select all N matching' only when more leads match than the page shows", () => {
    assert.equal(renderToStaticMarkup(<SelectAllMatching pageCount={20} total={20} allSelected={false} onSelectAll={() => undefined} onClear={() => undefined} />), "");
    const offer = renderToStaticMarkup(<SelectAllMatching pageCount={20} total={56000} allSelected={false} onSelectAll={() => undefined} onClear={() => undefined} />);
    assert.match(offer, /Select all 56,000 leads matching this filter/);
    const done = renderToStaticMarkup(<SelectAllMatching pageCount={20} total={56000} allSelected onSelectAll={() => undefined} onClear={() => undefined} />);
    assert.match(done, /56,000<\/strong> leads matching this filter are selected/);
  });
});
