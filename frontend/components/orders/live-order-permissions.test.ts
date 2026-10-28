// Run with: ../backend/node_modules/.bin/tsx --test components/orders/live-order-permissions.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canSyncLiveOrder } from "./live-order-permissions";

describe("who is offered Sync order to CRM", () => {
  it("Admin, Manager, Telecaller (SALESPERSON) and HR; nobody else", () => {
    for (const r of ["ADMIN", "MANAGER", "SALESPERSON", "HR"]) assert.equal(canSyncLiveOrder(r), true, r);
    for (const r of ["RECRUITER", "", undefined, null, "admin"]) assert.equal(canSyncLiveOrder(r as never), false, String(r));
  });
});
