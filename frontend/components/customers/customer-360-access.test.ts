// Run with: ../backend/node_modules/.bin/tsx --test components/customers/customer-360-access.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { customer360Sections, READ_ONLY_NOTICE } from "./customer-360-access";
import { customerDetailHref } from "../orders/orders-table";

describe("customer-name link and the Customer 360 page it opens", () => {
  it("every customer-name link targets /dashboard/customers/<lead id>, the route of the Customer 360 page, with the canonical lead id untouched", () => {
    const id = "0b7c1f0e-1111-4222-8333-444455556666";
    assert.equal(customerDetailHref(id), `/dashboard/customers/${id}`);
    assert.match(customerDetailHref(id), /^\/dashboard\/customers\/[0-9a-f-]{36}$/);
  });
  it("a normal view keeps every action and section (delete stays admin-only)", () => {
    assert.deepEqual(customer360Sections({ readOnly: false, role: "SALESPERSON" }), { edit: true, delete: false, sendWhatsApp: true, conversation: true, timeline: true, history: true });
    assert.equal(customer360Sections({ readOnly: false, role: "ADMIN" }).delete, true);
  });
  it("a read-only view (opened from someone else's order) offers no action and no strictly-scoped section - for every role, admin included", () => {
    for (const role of ["ADMIN", "MANAGER", "SALESPERSON", undefined]) {
      assert.deepEqual(customer360Sections({ readOnly: true, role }), { edit: false, delete: false, sendWhatsApp: false, conversation: false, timeline: false, history: false });
    }
    assert.match(READ_ONLY_NOTICE, /Read-only/);
  });
});
