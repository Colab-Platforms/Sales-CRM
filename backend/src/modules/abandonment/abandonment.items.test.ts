import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { abandonmentItemsWhere, aggregateItemOptions, decodeItemKey, encodeItemKeys, itemKeyOf, parseItemKeys } from "./abandonment.items.js";
import { buildAbandonmentListWhere } from "./abandonment.filters.js";
import { validateListAbandonmentsQuery } from "./abandonment.validators.js";
import { parseAbandonmentEvent } from "../shiprocket/shiprocket.abandonment.mapper.js";
import { Role } from "../../../generated/prisma/enums.js";

const item = (name: string, o: Partial<{ productId: string; variantId: string; sku: string }> = {}) => ({ productId: null, variantId: null, sku: null, name, quantity: 1, ...o });

describe("item keys", () => {
  it("prefer product id, then variant id, then SKU, then name", () => {
    assert.equal(itemKeyOf(item("Sleep Gummies", { productId: "9", variantId: "8", sku: "SG" })), "p:9|Sleep Gummies");
    assert.equal(itemKeyOf(item("Sleep Gummies", { variantId: "8", sku: "SG" })), "v:8|Sleep Gummies");
    assert.equal(itemKeyOf(item("Sleep Gummies", { sku: "SG" })), "s:SG|Sleep Gummies");
    assert.equal(itemKeyOf(item("Sleep Gummies")), "n:Sleep Gummies");
  });
  it("round-trip through the query string, including names with commas, pipes and non-ASCII", () => {
    const keys = ["s:SG-1|Sleep, Gummies | 30ct", "n:Dia Shield — टैबलेट"];
    assert.deepEqual(parseItemKeys(encodeItemKeys(keys)), keys);
    assert.deepEqual(decodeItemKey("s:SG-1|Sleep, Gummies | 30ct"), { kind: "s", value: "SG-1", name: "Sleep, Gummies | 30ct" });
  });
  it("malformed or oversized lists are rejected, not ignored", () => {
    assert.equal(parseItemKeys("nonsense"), null);
    assert.equal(parseItemKeys("x:1"), null);
    assert.equal(parseItemKeys("%E0%A4%A"), null);
    assert.equal(parseItemKeys(Array.from({ length: 51 }, (_, i) => `s:${i}`).join(",")), null);
    assert.deepEqual(parseItemKeys(""), []);
  });
});

describe("where clause", () => {
  it("one product -> a single containment test on the stable id (plus the name for older carts); several -> OR", () => {
    const one = abandonmentItemsWhere(["s:SG|Sleep Gummies"]) as any;
    assert.deepEqual(one.OR[0], { cartSnapshot: { path: ["items"], array_contains: [{ sku: "SG" }] } });
    assert.deepEqual(one.OR[1], { cartSnapshot: { path: ["itemNames"], array_contains: "Sleep Gummies" } });
    const many = abandonmentItemsWhere(["p:1|A", "n:B"]) as any;
    assert.equal(many.OR.length, 3);
  });
  it("a key list with nothing usable matches NOTHING (never everything)", () => {
    assert.deepEqual(abandonmentItemsWhere(["garbage"]), { id: { in: [] } });
  });
  it("combines with the existing filters (AND), not instead of them", () => {
    const where = buildAbandonmentListWhere({ page: 1, pageSize: 20, items: ["s:SG|Sleep Gummies"], workingStatus: "NEW", assignment: "UNASSIGNED", search: "priya" } as never, {}, Role.ADMIN) as { AND: unknown[] };
    const text = JSON.stringify(where);
    assert.ok(text.includes('"array_contains":[{"sku":"SG"}]') && text.includes('"workingStatus":"NEW"') && text.includes('"assignedManagerId":null') && text.includes("priya"));
    assert.equal(where.AND.length, 4);
  });
  it("the query validator decodes ?items= and rejects garbage with a 400-style error", () => {
    const ok = validateListAbandonmentsQuery({ items: encodeItemKeys(["s:SG|Sleep Gummies", "n:Varjasaki"]) });
    assert.deepEqual(ok.value?.items, ["s:SG|Sleep Gummies", "n:Varjasaki"]);
    assert.equal(validateListAbandonmentsQuery({ items: "zzz" }).error?.message.includes("Invalid items filter"), true);
    assert.equal(validateListAbandonmentsQuery({}).value?.items, undefined);
    assert.equal(validateListAbandonmentsQuery({ items: "" }).value?.items, undefined);
  });
});

describe("options (distinct products from real cart data)", () => {
  const rows = [
    { id: "a1", cartSnapshot: { itemNames: ["Herbal Paan Masala", "Sleep Gummies"], items: [{ sku: "HPM", name: "Herbal Paan Masala", quantity: 2 }, { sku: "SG", name: "Sleep Gummies", quantity: 1 }] } },
    { id: "a2", cartSnapshot: { itemNames: ["Herbal Paan Masala"], items: [{ sku: "HPM", name: "Herbal Paan Masala", quantity: 1 }] } },
    { id: "a3", cartSnapshot: { itemNames: ["Varjasaki", "Herbal Paan Masala"] } }, // older cart: names only
    { id: "a4", cartSnapshot: null },
  ];
  it("lists each product once with how many carts contain it; names-only carts fold into the same product; no hardcoded names", () => {
    const o = aggregateItemOptions(rows);
    assert.deepEqual(o.map((x) => [x.name, x.sku, x.count]), [["Herbal Paan Masala", "HPM", 3], ["Sleep Gummies", "SG", 1], ["Varjasaki", null, 1]]);
    assert.deepEqual(o.map((x) => x.key), ["s:HPM|Herbal Paan Masala", "s:SG|Sleep Gummies", "n:Varjasaki"]);
  });
  it("search matches name or SKU, case-insensitively; no match -> empty", () => {
    assert.deepEqual(aggregateItemOptions(rows, "gumm").map((x) => x.name), ["Sleep Gummies"]);
    assert.deepEqual(aggregateItemOptions(rows, "hpm").map((x) => x.name), ["Herbal Paan Masala"]);
    assert.deepEqual(aggregateItemOptions(rows, "zzz"), []);
  });
});

describe("webhook parsing keeps stable identifiers", () => {
  it("stores SKU / product id / variant id per line when Fastrr sends them, and null (never invented) when it does not", () => {
    const parsed = parseAbandonmentEvent({ phone_number: "9000000001", items: [{ sku: "SG", name: "Sleep Gummies", quantity: 2, product_id: 55, variant_id: "77" }, { title: "Varjasaki", quantity: 1 }] });
    assert.deepEqual(parsed?.items, [
      { productId: "55", variantId: "77", sku: "SG", name: "Sleep Gummies", quantity: 2 },
      { productId: null, variantId: null, sku: null, name: "Varjasaki", quantity: 1 },
    ]);
    assert.deepEqual(parsed?.itemNames, ["Sleep Gummies", "Varjasaki"]);
  });
});
