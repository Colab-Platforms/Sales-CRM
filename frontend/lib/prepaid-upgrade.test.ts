// Run with: ../backend/node_modules/.bin/tsx --test lib/prepaid-upgrade.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { previewUpgrade } from "./prepaid-upgrade";

describe("previewUpgrade (mirrors the backend rule)", () => {
  it("1249 - 100 = 1149 and 10% of 1249 = 124.90", () => {
    assert.deepEqual(previewUpgrade(124900, "FIXED", "100"), { ok: true, discountCents: 10000, prepaidCents: 114900 });
    assert.deepEqual(previewUpgrade(124900, "PERCENT", "10"), { ok: true, discountCents: 12490, prepaidCents: 112410 });
  });
  it("silent on empty input, specific messages otherwise", () => {
    assert.deepEqual(previewUpgrade(124900, "FIXED", ""), { ok: false, error: null });
    assert.deepEqual(previewUpgrade(124900, "FIXED", "-5"), { ok: false, error: "Discount cannot be negative" });
    assert.deepEqual(previewUpgrade(124900, "FIXED", "abc"), { ok: false, error: "Enter a valid discount" });
    assert.deepEqual(previewUpgrade(124900, "FIXED", "0"), { ok: false, error: "Discount must be greater than 0" });
    assert.equal((previewUpgrade(124900, "FIXED", "1249") as { error: string }).error, "Discount cannot be greater than or equal to the order amount.");
    assert.equal((previewUpgrade(124900, "PERCENT", "101") as { error: string }).error, "Percentage cannot exceed 100");
    assert.equal((previewUpgrade(124900, "PERCENT", "100") as { error: string }).error, "Discount cannot be greater than or equal to the order amount.");
  });
});
