import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_TYPE_COLORS, ACTIVITY_TYPE_LABELS } from "./audit-status";

describe("Audit Trail refund action labels", () => {
  it("every refund lifecycle type has a label and a colour (no empty badge)", () => {
    const expected: Record<string, string> = {
      REFUND_REQUESTED: "Refund requested",
      REFUND_APPROVED: "Refund approved (not refunded yet)",
      REFUND_REJECTED: "Refund rejected",
      REFUND_EXECUTION_STARTED: "Refund execution started",
      REFUND_COMPLETED: "Refund completed",
      REFUND_EXECUTION_FAILED: "Refund execution failed",
    };
    for (const [type, label] of Object.entries(expected)) {
      assert.equal((ACTIVITY_TYPE_LABELS as Record<string, string>)[type], label, type);
      assert.ok((ACTIVITY_TYPE_COLORS as Record<string, string>)[type], `${type} colour`);
    }
  });
  it("no activity type is left without a label", () => {
    for (const [type, label] of Object.entries(ACTIVITY_TYPE_LABELS)) assert.ok(label && label.trim() !== "", type);
    assert.deepEqual(Object.keys(ACTIVITY_TYPE_LABELS).sort(), Object.keys(ACTIVITY_TYPE_COLORS).sort());
  });
});
