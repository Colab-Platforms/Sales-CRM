// Run with: ../backend/node_modules/.bin/tsx --test components/orders/customer-details-link.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { customerDetailsTarget } from "./customer-details-link";

describe("View Customer Details destination", () => {
  it("a telecaller goes straight to THAT customer's abandoned lead (lead id + abandonment id), not to the abandoned-leads list", () => {
    const t = customerDetailsTarget({ role: "SALESPERSON", leadId: "lead-9", abandonmentId: "ab-3" });
    assert.equal(t.href, "/dashboard/leads/lead-9?from=abandoned-leads&abandonmentId=ab-3");
    assert.equal(t.abandoned, true);
    assert.equal(t.note, null);
    assert.ok(!t.href.endsWith("/dashboard/abandoned-leads"), "not the list");
  });
  it("with no abandoned lead (or none the telecaller may open) it falls back to the SAME customer's profile and says so - never another lead", () => {
    for (const abandonmentId of [null, undefined]) {
      const t = customerDetailsTarget({ role: "SALESPERSON", leadId: "lead-9", abandonmentId });
      assert.equal(t.href, "/dashboard/customers/lead-9");
      assert.equal(t.abandoned, false);
      assert.match(t.note ?? "", /No abandoned lead exists for this customer/);
    }
  });
  it("other roles keep the customer profile exactly as before, with no note", () => {
    for (const role of ["ADMIN", "MANAGER", "HR", undefined]) {
      const t = customerDetailsTarget({ role, leadId: "lead-9", abandonmentId: "ab-3" });
      assert.deepEqual(t, { href: "/dashboard/customers/lead-9", abandoned: false, note: null });
    }
  });
});
