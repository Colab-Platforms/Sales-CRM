// Pure-logic unit tests for E7.6's trigger-mapping/eventKey helpers - no database, mirrors how
// whatsapp.variable-resolver.ts and orders.filters.ts's pure functions are tested separately from
// their DB-integration counterparts (see whatsapp.automation.db-test.ts for the dispatch/scheduler
// behaviour these helpers feed into).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { followUpDueEventKey, orderAutomationEventKey, orderStatusAutomationType, paymentPendingEventKey } from "./whatsapp.automation.triggers.js";

describe("orderStatusAutomationType", () => {
  it("maps the four order-level automation statuses", () => {
    assert.equal(orderStatusAutomationType("CONFIRMED"), "ORDER_CONFIRMED");
    assert.equal(orderStatusAutomationType("SHIPPED"), "ORDER_SHIPPED");
    assert.equal(orderStatusAutomationType("OUT_FOR_DELIVERY"), "ORDER_OUT_FOR_DELIVERY");
    assert.equal(orderStatusAutomationType("DELIVERED"), "ORDER_DELIVERED");
  });

  it("returns null for every other order status - never guesses", () => {
    for (const status of ["DRAFT", "PENDING_PAYMENT", "PROCESSING", "CANCELLED", "RETURNED", "REFUNDED"] as const) {
      assert.equal(orderStatusAutomationType(status), null);
    }
  });
});

describe("event keys", () => {
  it("orderAutomationEventKey is stable for the same order and type, and differs across orders/types", () => {
    assert.equal(orderAutomationEventKey("ORDER_CONFIRMED", "order-1"), orderAutomationEventKey("ORDER_CONFIRMED", "order-1"));
    assert.notEqual(orderAutomationEventKey("ORDER_CONFIRMED", "order-1"), orderAutomationEventKey("ORDER_SHIPPED", "order-1"));
    assert.notEqual(orderAutomationEventKey("ORDER_CONFIRMED", "order-1"), orderAutomationEventKey("ORDER_CONFIRMED", "order-2"));
  });

  it("paymentPendingEventKey is stable within the same UTC calendar day and changes the next day", () => {
    const morning = new Date("2026-09-20T01:00:00Z");
    const night = new Date("2026-09-20T23:00:00Z");
    const nextDay = new Date("2026-09-21T01:00:00Z");
    assert.equal(paymentPendingEventKey("order-1", morning), paymentPendingEventKey("order-1", night));
    assert.notEqual(paymentPendingEventKey("order-1", morning), paymentPendingEventKey("order-1", nextDay));
  });

  it("followUpDueEventKey is stable for the same task and differs across tasks", () => {
    assert.equal(followUpDueEventKey("task-1"), followUpDueEventKey("task-1"));
    assert.notEqual(followUpDueEventKey("task-1"), followUpDueEventKey("task-2"));
  });
});
