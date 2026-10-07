// Run with: ../backend/node_modules/.bin/tsx --test components/abandonment/items-filter.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ItemsFilter } from "./items-filter";
import { cartLines, encodeItemKeys, itemKeyLabel, lineLabel, searchItemOptions, toggleKey, type ItemOption } from "@/lib/abandonment-items";

const options: ItemOption[] = [
  { key: "s:HPM|Herbal Paan Masala", name: "Herbal Paan Masala", sku: "HPM", count: 3 },
  { key: "s:SG|Sleep Gummies", name: "Sleep Gummies", sku: "SG", count: 1 },
  { key: "n:Varjasaki", name: "Varjasaki", sku: null, count: 1 },
];
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("Items filter helpers", () => {
  it("keys survive the query string (commas and non-ASCII included) and give readable labels", () => {
    const keys = ["s:SG|Sleep, Gummies", "n:Dia Shield — टैबलेट"];
    assert.deepEqual(encodeItemKeys(keys).split(",").map(decodeURIComponent), keys);
    assert.equal(itemKeyLabel("s:SG|Sleep Gummies"), "Sleep Gummies");
    assert.equal(itemKeyLabel("n:Varjasaki"), "Varjasaki");
    assert.equal(itemKeyLabel("p:123"), "123");
  });
  it("search matches name or SKU, case-insensitively; toggling adds then removes", () => {
    assert.deepEqual(searchItemOptions(options, "gumm").map((o) => o.name), ["Sleep Gummies"]);
    assert.deepEqual(searchItemOptions(options, "hpm").map((o) => o.name), ["Herbal Paan Masala"]);
    assert.deepEqual(searchItemOptions(options, "zzz"), []);
    assert.deepEqual(toggleKey([], "a"), ["a"]);
    assert.deepEqual(toggleKey(["a", "b"], "a"), ["b"]);
  });
  it("Items column lines: 'Name × qty' when quantities exist, plain names for older carts", () => {
    const snap = { itemNames: ["Herbal Paan Masala", "Sleep Gummies"], items: [{ productId: null, variantId: null, sku: "HPM", name: "Herbal Paan Masala", quantity: 2 }, { productId: null, variantId: null, sku: "SG", name: "Sleep Gummies", quantity: 1 }] };
    assert.deepEqual(cartLines(snap).map(lineLabel), ["Herbal Paan Masala × 2", "Sleep Gummies × 1"]);
    assert.deepEqual(cartLines({ itemNames: ["Varjasaki"] }).map(lineLabel), ["Varjasaki"]);
    assert.deepEqual(cartLines(null, ["Fallback"]).map(lineLabel), ["Fallback"]);
    assert.deepEqual(cartLines(null), []);
  });
});

describe("ItemsFilter", () => {
  it("renders an Items funnel; inactive by default and marked active when products are selected", () => {
    const off = renderToStaticMarkup(<ItemsFilter options={options} selected={[]} onChange={() => {}} />);
    assert.match(off, /aria-label="Filter Items"/);
    assert.match(off, /data-active="false"/);
    const on = renderToStaticMarkup(<ItemsFilter options={options} selected={["s:SG|Sleep Gummies", "n:Varjasaki"]} onChange={() => {}} />);
    assert.match(on, /data-active="true"/);
    assert.match(on, /Sleep Gummies, Varjasaki/);
    assert.ok(!text(off).includes("SAVE"));
  });
});
