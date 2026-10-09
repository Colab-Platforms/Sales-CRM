import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crmOwnedTotal } from "./orders.live.service.js";

describe("crmOwnedTotal (which total the live orders list shows)", () => {
  const crm = (source: string, total: string) => ({ source, totalAmount: { toString: () => total } });
  it("a CRM-created order shows the CRM total (1165.72), not Shopify's own copy (999)", () => {
    assert.equal(crmOwnedTotal(crm("SALESPERSON", "1165.72"), "999.0"), "1165.72");
    assert.equal(crmOwnedTotal(crm("API", "500.00"), "400.0"), "500.00");
  });
  it("a Shopify-originated order, or one with no CRM row, shows Shopify's live total", () => {
    assert.equal(crmOwnedTotal(crm("SHOPIFY", "699.00"), "749.00"), "749.00");
    assert.equal(crmOwnedTotal(undefined, "749.00"), "749.00");
    assert.equal(crmOwnedTotal(undefined, null), "0");
  });
});
