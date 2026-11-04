// Run with: npx tsx --test src/modules/products/products.measurement-corrections.test.ts   (no database)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCorrectionRecord } from "./products.measurement-corrections.js";

const rec = (o: Record<string, string>) => ({ masterskucode: "AW-X", productname: "X", updatetype: "FILL", proposedweightkg: "", proposedlengthcm: "", proposedbreadthcm: "", proposedheightcm: "", ...o });
const row = (o: Record<string, string>) => parseCorrectionRecord(rec(o), 2);

describe("parsing one correction row", () => {
  it("accepts only the fields that have a value; blank cells are 'no change'", () => {
    const r = row({ proposedweightkg: "0.25", proposedheightcm: "3.5" });
    assert.ok(r.kind === "row");
    assert.deepEqual(r.row.values, { weightKg: 0.25, heightCm: 3.5 });
    assert.equal(r.row.type, "FILL");
  });
  it("a row with nothing proposed is skipped, not an error (the template ships blank)", () => {
    assert.equal(row({}).kind, "skip");
    assert.equal(row({ masterskucode: "" }).kind, "skip");
  });
  it("rejects zero, negative, non-numeric, scientific and over-precise values - nothing is rounded", () => {
    for (const bad of ["0", "0.0", "-1", "abc", "1e3", "1,5", "0.1234"]) {
      const r = row({ proposedweightkg: bad });
      assert.equal(r.kind, "error", bad);
    }
    assert.equal(row({ proposedlengthcm: "12.345" }).kind, "error");
    assert.equal(row({ proposedlengthcm: "301" }).kind, "error");
    assert.equal(row({ proposedweightkg: "101" }).kind, "error");
  });
  it("needs a SKU when values are given: a name is never used to find a product (bundles included)", () => {
    const r = row({ masterskucode: "", productname: "Immunity & Vitality Bundle", proposedweightkg: "0.5" });
    assert.ok(r.kind === "error" && /matched by SKU only, never by name/.test(r.message));
  });
  it("Update Type must be FILL or REPLACE", () => {
    assert.equal(row({ proposedweightkg: "0.5", updatetype: "" }).kind, "error");
    assert.equal(row({ proposedweightkg: "0.5", updatetype: "overwrite" }).kind, "error");
    const r = row({ proposedweightkg: "0.5", updatetype: "replace" });
    assert.ok(r.kind === "row" && r.row.type === "REPLACE");
  });
  it("a SKU a spreadsheet turned into scientific notation is rejected", () => {
    assert.equal(row({ masterskucode: "8.00994E+12", proposedweightkg: "0.5" }).kind, "error");
  });
});
