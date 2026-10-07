import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePercentDiscount } from "./orders.discount.js";

const run = (base: string, pct: string) => {
  const r = computePercentDiscount(Math.round(Number(base) * 100), pct);
  return { discount: (r.discountCents / 100).toFixed(2), final: (r.finalCents / 100).toFixed(2), percent: r.percent };
};

describe("computePercentDiscount", () => {
  it("matches the specified examples", () => {
    assert.deepEqual(run("699", "0"), { discount: "0.00", final: "699.00", percent: "0.00" });
    assert.deepEqual(run("699", "7"), { discount: "48.93", final: "650.07", percent: "7.00" });
    assert.deepEqual(run("699", "15"), { discount: "104.85", final: "594.15", percent: "15.00" });
    assert.deepEqual(run("1000", "10"), { discount: "100.00", final: "900.00", percent: "10.00" });
  });
  it("treats the number as a percentage, never rupees (1799 @ 7 = 125.93, not 7.00)", () => {
    assert.deepEqual(run("1799", "7"), { discount: "125.93", final: "1673.07", percent: "7.00" });
    assert.deepEqual(run("1799", "0"), { discount: "0.00", final: "1799.00", percent: "0.00" });
    assert.deepEqual(run("1799", "15"), { discount: "269.85", final: "1529.15", percent: "15.00" });
    assert.notEqual(run("1799", "7").discount, "7.00");
  });
  it("949 with no discount is untouched; 5 means 5%, never 5 rupees", () => {
    assert.deepEqual(run("949", "0"), { discount: "0.00", final: "949.00", percent: "0.00" });
    assert.deepEqual(run("949", "5"), { discount: "47.45", final: "901.55", percent: "5.00" });
    assert.deepEqual(run("949", "7"), { discount: "66.43", final: "882.57", percent: "7.00" });
    assert.deepEqual(run("949", "15"), { discount: "142.35", final: "806.65", percent: "15.00" });
  });
  it("Dia Shield Tablets / Pack Of 3 (1249): no discount stays 1249; 5/7/15 are percentages", () => {
    assert.deepEqual(run("1249", "0"), { discount: "0.00", final: "1249.00", percent: "0.00" });
    assert.deepEqual(run("1249", "5"), { discount: "62.45", final: "1186.55", percent: "5.00" });
    assert.deepEqual(run("1249", "7"), { discount: "87.43", final: "1161.57", percent: "7.00" });
    assert.deepEqual(run("1249", "15"), { discount: "187.35", final: "1061.65", percent: "15.00" });
  });
  it("supports 100% and decimal percentages with half-up cent rounding", () => {
    assert.equal(run("699", "100").final, "0.00");
    assert.equal(run("100.05", "12.5").discount, "12.51"); // 12.50625 -> 12.51
    assert.equal(run("0.10", "50").discount, "0.05");
  });
  it("rejects negative, >100, and non-numeric input with the specified messages", () => {
    assert.throws(() => computePercentDiscount(69900, "-1"), /cannot be negative/);
    assert.throws(() => computePercentDiscount(69900, "100.01"), /cannot exceed 100%/);
    assert.throws(() => computePercentDiscount(69900, "101"), /cannot exceed 100%/);
    for (const bad of ["abc", "", "7%", "1e2", "7.123", "NaN", "Infinity"]) assert.throws(() => computePercentDiscount(69900, bad), /valid discount percentage/, bad);
  });
});
