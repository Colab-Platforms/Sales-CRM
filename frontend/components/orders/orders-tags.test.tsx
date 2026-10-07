// Run with: ../backend/node_modules/.bin/tsx --test components/orders/orders-tags.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { OrderTagChips, splitTags } from "./order-tag-chips";
import { OrdersTagsFilter, tagFilterOptions } from "./orders-tags-filter";
import { EMPTY_FILTERS, filtersToApi, filtersToParams, hasActiveColumnFilters, isColumnActive, parseColumnFilters } from "./orders-column-filters";
import { headerFilterNodes } from "./orders-header-filters";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("tag chips", () => {
  it("no tags -> a dash; a few tags -> chips, no +N", () => {
    assert.match(text(renderToStaticMarkup(<OrderTagChips tags={[]} />)), /^—$/);
    assert.match(text(renderToStaticMarkup(<OrderTagChips tags={undefined} />)), /^—$/);
    const h = renderToStaticMarkup(<OrderTagChips tags={["CRM Confirmed by Vini", "COD"]} />);
    assert.match(text(h), /CRM Confirmed by Vini COD/);
    assert.doesNotMatch(h, /\+\d/);
  });
  it("many tags: the first two, then +N that can open the full list", () => {
    assert.deepEqual(splitTags(["a", "b", "c", "d"]), { visible: ["a", "b"], hidden: ["c", "d"] });
    const h = renderToStaticMarkup(<OrderTagChips tags={["CRM Confirmed by Vini", "COD", "VIP", "Fastrr"]} />);
    assert.match(text(h), /CRM Confirmed by Vini COD \+2/);
    assert.match(h, /aria-label="Show all 4 tags"/);
    assert.ok(!text(h).includes("Fastrr"), "hidden tags are only in the popover, not in the cell");
    assert.match(h, /title="CRM Confirmed by Vini, COD, VIP, Fastrr"/);
  });
});

describe("tags filter options", () => {
  const available = [{ name: "CRM Confirmed by Vini", source: "CRM" as const }, { name: "COD", source: "SHOPIFY" as const }, { name: "VIP", source: "SHOPIFY" as const }];
  it("lists real tags; search narrows them; a selected tag stays listed", () => {
    assert.deepEqual(tagFilterOptions(available, [], "").options.map((o) => o.value), ["CRM Confirmed by Vini", "COD", "VIP"]);
    assert.deepEqual(tagFilterOptions(available, [], "vi").options.map((o) => o.value), ["CRM Confirmed by Vini", "VIP"]);
    assert.deepEqual(tagFilterOptions(available, ["COD"], "vip").options.map((o) => o.value), ["COD", "VIP"]);
    assert.deepEqual(tagFilterOptions(available, ["Gone Tag"], "").options.map((o) => o.value), ["CRM Confirmed by Vini", "COD", "VIP", "Gone Tag"]);
  });
  it("a typed tag that is not listed can be added as-is (never a comma, never a duplicate)", () => {
    assert.equal(tagFilterOptions(available, [], "Campaign-Diwali").custom, "Campaign-Diwali");
    assert.equal(tagFilterOptions(available, [], "cod").custom, null);
    assert.equal(tagFilterOptions(available, [], "a,b").custom, null);
    assert.equal(tagFilterOptions(available, [], "  ").custom, null);
  });
  it("the funnel is inactive with nothing selected and shows the selection when active", () => {
    const off = renderToStaticMarkup(<OrdersTagsFilter selected={[]} onChange={() => {}} available={available} />);
    assert.match(off, /aria-label="Filter Tags"/);
    assert.match(off, /data-active="false"/);
    const on = renderToStaticMarkup(<OrdersTagsFilter selected={["COD", "VIP"]} onChange={() => {}} available={available} />);
    assert.match(on, /data-active="true"/);
    assert.match(on, /COD, VIP/);
  });
});

describe("tags in the Orders filter state", () => {
  it("round-trips through the URL (comma list), including tags with spaces", () => {
    const patch = filtersToParams({ tags: ["CRM Confirmed by Vini", "COD"] });
    assert.equal(patch.tags, "CRM Confirmed by Vini,COD");
    const parsed = parseColumnFilters(new URLSearchParams({ tags: patch.tags! }));
    assert.deepEqual(parsed.tags, ["CRM Confirmed by Vini", "COD"]);
    assert.equal(filtersToParams({ tags: [] }).tags, undefined, "clearing removes the param");
  });
  it("counts as an active filter and is sent to the API alongside the others", () => {
    assert.equal(isColumnActive({ ...EMPTY_FILTERS, tags: ["COD"] }, "tags"), true);
    assert.equal(hasActiveColumnFilters({ ...EMPTY_FILTERS, tags: ["COD"] }), true);
    assert.equal(hasActiveColumnFilters(EMPTY_FILTERS), false);
    const api = filtersToApi({ ...EMPTY_FILTERS, tags: ["COD", "VIP"], paymentMode: ["COD"], status: ["CONFIRMED"] });
    assert.deepEqual([api.tags, api.paymentMode, api.status], [["COD", "VIP"], ["COD"], ["CONFIRMED"]]);
    assert.equal(filtersToApi(EMPTY_FILTERS).tags, undefined);
  });
  it("junk in the URL is ignored", () => {
    assert.deepEqual(parseColumnFilters(new URLSearchParams({ tags: ",,  ," })).tags, []);
  });
  it("the header offers a Tags funnel next to the other column filters", () => {
    const nodes = headerFilterNodes({ filters: EMPTY_FILTERS, onChange: () => {}, salespeople: [], leadSources: [], showSalesperson: false });
    assert.ok("Tags" in nodes && "Payment" in nodes && "Status" in nodes && "Date" in nodes);
  });
});
