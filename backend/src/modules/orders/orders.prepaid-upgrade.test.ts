import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeUpgradeAmounts } from "./orders.prepaid-upgrade.calc.js";

const calc = (original: string, type: "FIXED" | "PERCENT", value: string | number) => {
  const r = computeUpgradeAmounts(Math.round(Number(original) * 100), type, value);
  return { discount: (r.discountCents / 100).toFixed(2), pay: (r.prepaidCents / 100).toFixed(2), value: r.discountValue };
};

describe("computeUpgradeAmounts", () => {
  it("fixed: 1249 - 100 = 1149, and the other common values", () => {
    assert.deepEqual(calc("1249", "FIXED", "100"), { discount: "100.00", pay: "1149.00", value: "100.00" });
    for (const [v, pay] of [["50", "1199.00"], ["150", "1099.00"], ["200", "1049.00"]]) assert.equal(calc("1249", "FIXED", v).pay, pay);
  });
  it("custom and decimal rupee amounts", () => {
    assert.deepEqual(calc("1249", "FIXED", "99.50"), { discount: "99.50", pay: "1149.50", value: "99.50" });
    assert.equal(calc("1249", "FIXED", 75).pay, "1174.00");
  });
  it("percentage: 5% and 10% of 1249, half-up cent rounding, no float drift", () => {
    assert.deepEqual(calc("1249", "PERCENT", "5"), { discount: "62.45", pay: "1186.55", value: "5.00" });
    assert.deepEqual(calc("1249", "PERCENT", "10"), { discount: "124.90", pay: "1124.10", value: "10.00" });
    assert.equal(calc("0.10", "PERCENT", "50").discount, "0.05");
    assert.equal(calc("1000.05", "PERCENT", "12.5").discount, "125.01"); // 125.00625 -> 125.01
  });
  it("rejects zero, negative, malformed and too-precise values", () => {
    for (const bad of ["0", "0.00"]) assert.throws(() => calc("1249", "FIXED", bad), /greater than 0/);
    assert.throws(() => calc("1249", "FIXED", "-1"), /negative/);
    for (const bad of ["abc", "", "1e2", "1,000", "₹100", "10%", "1.234", "NaN"]) assert.throws(() => calc("1249", "FIXED", bad), /valid discount/, bad);
  });
  it("rejects a discount equal to or above the order amount, so the payable amount is always > 0", () => {
    assert.throws(() => calc("1249", "FIXED", "1249"), /greater than or equal to the order amount/);
    assert.throws(() => calc("1249", "FIXED", "1249.01"), /greater than or equal/);
    assert.throws(() => calc("1249", "PERCENT", "100"), /greater than or equal/);
    assert.equal(calc("1249", "FIXED", "1248.99").pay, "0.01");
  });
  it("percentage above 100 is rejected; a percent that rounds to zero is rejected", () => {
    assert.throws(() => calc("1249", "PERCENT", "100.01"), /cannot exceed 100/);
    assert.throws(() => calc("1249", "PERCENT", "101"), /cannot exceed 100/);
    assert.throws(() => calc("0.10", "PERCENT", "1"), /too small/);
  });
});
