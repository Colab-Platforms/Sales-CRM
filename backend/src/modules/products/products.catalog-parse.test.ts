import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { parse } from "csv-parse";
import { headerKey, looksLikeScientificNotation, parseCatalogRow, parseDimensions, parseWeightKg } from "./products.catalog-parse.js";
import { failedRowsCsv } from "./products.catalog-import.js";

const rec = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [headerKey(k), v]));

describe("Shiprocket catalog parsing", () => {
  it("normalises the real Shiprocket headers (BOM, asterisk, spaces)", () => {
    assert.equal(headerKey("﻿*Channel Name"), "channelname");
    assert.equal(headerKey("*SKU Code"), "skucode");
    assert.equal(headerKey("Master SKU Code"), "masterskucode");
  });

  it("parses weights: real values kept, blank/0 = not recorded, grams-in-kg and junk rejected", () => {
    assert.deepEqual(parseWeightKg("0.250"), { ok: true, kg: 0.25 });
    assert.deepEqual(parseWeightKg("0.000"), { ok: true, kg: null });
    assert.deepEqual(parseWeightKg(""), { ok: true, kg: null });
    assert.equal(parseWeightKg("200.000").ok, false);
    assert.equal(parseWeightKg("abc").ok, false);
    assert.equal(parseWeightKg("-1").ok, false);
  });

  it("parses LxBxH dimensions into structured cm values; zero sides = not recorded; malformed = error", () => {
    assert.deepEqual(parseDimensions("20.000x15.000x2.000"), { ok: true, dimensions: { lengthCm: 20, widthCm: 15, heightCm: 2 } });
    assert.deepEqual(parseDimensions("25.000x4.000x20.000"), { ok: true, dimensions: { lengthCm: 25, widthCm: 4, heightCm: 20 } });
    assert.deepEqual(parseDimensions("0.000x0.000x0.000"), { ok: true, dimensions: null });
    assert.deepEqual(parseDimensions(""), { ok: true, dimensions: null });
    assert.equal(parseDimensions("20x15").ok, false);
    assert.equal(parseDimensions("999x1x1").ok, false);
  });

  it("keeps SKU codes as strings (leading zeros, long digit strings) and orders identities Master SKU > SKU > Channel SKU", () => {
    const r = parseCatalogRow(rec({ "*SKU Code": "0012", "Master SKU Code": "50764869599421", "Channel SKU Code": "CH-1", Weight: "0.2" }));
    assert.ok(r.ok);
    assert.deepEqual(r.row.skus, ["50764869599421", "0012", "CH-1"]);
    assert.equal(typeof r.row.skus[0], "string");
  });

  it("rejects a SKU that a spreadsheet turned into scientific notation instead of matching on it", () => {
    assert.ok(looksLikeScientificNotation("8.00994E+12"));
    assert.ok(!looksLikeScientificNotation("AW-HM-CR-120"));
    assert.ok(!looksLikeScientificNotation("50764869599421"));
    const r = parseCatalogRow(rec({ "*SKU Code": "8.00994E+12", Weight: "0.2" }));
    assert.equal(r.ok, false);
  });

  it("a row with neither SKU is an error; an invalid weight is an error carrying the SKU", () => {
    assert.equal(parseCatalogRow(rec({ Weight: "1" })).ok, false);
    const bad = parseCatalogRow(rec({ "*SKU Code": "X", Weight: "9999" }));
    assert.ok(!bad.ok);
    assert.equal(bad.sku, "X");
  });

  it("reads the real export shape through csv-parse without casting any field to a number", async () => {
    const csv = '﻿"*Channel Name","Product Name","*SKU Code",Weight,Dimensions,"Channel Product id","Master SKU Code"\n"Aayush (Shopify)","Herbal, Gutka",AW-HM-CR-120,0.250,20.000x15.000x2.000,8009941287101,AW-HM-CR-120\n';
    const rows: Record<string, string>[] = [];
    for await (const r of Readable.from([csv]).pipe(parse({ bom: true, columns: (h: string[]) => h.map(headerKey), trim: true, cast: false }))) rows.push(r);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.channelproductid, "8009941287101");
    const parsed = parseCatalogRow(rows[0]!);
    assert.ok(parsed.ok);
    assert.equal(parsed.row.weightKg, 0.25);
    assert.deepEqual(parsed.row.dimensions, { lengthCm: 20, widthCm: 15, heightCm: 2 });
    assert.equal(parsed.row.name, "Herbal, Gutka");
  });

  it("the failed-rows report quotes commas and quotes", () => {
    const csv = failedRowsCsv([{ row: 3, sku: "A", name: 'Tea, "Big"', status: "error", reason: "bad, value" }]);
    assert.equal(csv, 'row,sku,product_name,status,reason\n3,A,"Tea, ""Big""",error,"bad, value"\n');
  });
});
