import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canMarkPaid, markPaidMessage } from "./mark-paid";

const order = (o: Partial<{ status: string; paymentMode: string | null; paid: boolean }> = {}) =>
  ({ status: o.status ?? "PENDING_PAYMENT", paymentMode: o.paymentMode === undefined ? "PREPAID" : o.paymentMode, payments: [{ status: o.paid ? "SUCCESS" : "PENDING" }] }) as never;

describe("Mark as Paid visibility", () => {
  it("shown to admin, manager and salesperson for an unpaid prepaid order", () => {
    for (const role of ["ADMIN", "MANAGER", "SALESPERSON"]) assert.equal(canMarkPaid(order(), role), true, role);
  });
  it("hidden for HR, recruiters and signed-out users", () => {
    for (const role of ["HR", "RECRUITER", undefined]) assert.equal(canMarkPaid(order(), role), false, String(role));
  });
  it("hidden for COD, paid and cancelled orders", () => {
    assert.equal(canMarkPaid(order({ paymentMode: "COD" }), "ADMIN"), false);
    assert.equal(canMarkPaid(order({ paid: true }), "ADMIN"), false);
    assert.equal(canMarkPaid(order({ status: "CANCELLED" }), "ADMIN"), false);
  });
});

describe("Mark as Paid result message", () => {
  it("success is plain; an already-paid order says nothing changed", () => {
    assert.equal(markPaidMessage({ alreadyPaid: false, shopify: { linked: true, paymentSync: "synced" } }).ok, true);
    assert.match(markPaidMessage({ alreadyPaid: true, shopify: { linked: true, paymentSync: "synced" } }).text, /nothing was changed/);
  });
  it("a Shopify failure is shown with its reason and is not reported as plain success", () => {
    const m = markPaidMessage({ alreadyPaid: false, shopify: { linked: false, paymentSync: "pending", reason: "Shopify is down" } });
    assert.deepEqual([m.ok, /Shopify is down/.test(m.text)], [false, true]);
    assert.equal(markPaidMessage({ alreadyPaid: false, shopify: { linked: true, paymentSync: "failed", reason: "x" } }).ok, false);
  });
});
