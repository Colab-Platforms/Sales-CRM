// Refund APPROVAL workflow UI. Run with: ../backend/node_modules/.bin/tsx --test components/refunds/refunds.test.tsx
// (The approve confirmation and reject-reason dialogs render in a portal, which does not server-render; they are covered by the browser run.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { OrderRefundSectionBody, RefundRequestRow } from "./order-refund-section";
import { RefundRequestForm } from "./refund-request-dialog";
import { RefundQueueTable } from "./refund-queue-view";
import { APPROVAL_DISCLAIMER, canDecide, canRequestRefund, isApprover, validateRefundForm } from "@/lib/refund-status";
import type { OrderRefundInfo, RefundRequestView, RefundablePaymentView } from "@/lib/api-client/types/refunds.types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const payment = (over: Partial<RefundablePaymentView> = {}): RefundablePaymentView => ({ paymentId: "p1", method: "UPI", status: "SUCCESS", currency: "INR", amount: "1000.00", refundedAmount: "100.00", reservedAmount: "0.00", refundableAmount: "900.00", eligible: true, ineligibleReason: null, ...over });
const request = (over: Partial<RefundRequestView> = {}): RefundRequestView => ({
  id: "r1",
  orderId: "o1",
  orderNumber: "CRM-1",
  customer: { leadId: "l1", name: "Priya Shah", mobile: "9876500000" },
  paymentId: "p1",
  paymentMethod: "UPI",
  currency: "INR",
  paymentAmount: "1000.00",
  refundedAmount: "100.00",
  amount: "250.00",
  remainingRefundableAmount: "650.00",
  reason: "Wrong item delivered",
  status: "PENDING",
  requestedBy: { id: "u-sales", name: "Rep One", role: "SALESPERSON" },
  decidedBy: null,
  decisionAt: null,
  decisionNote: null,
  createdAt: "2026-10-06T10:00:00.000Z",
  ...over,
});

describe("refund form validation (early feedback only; the server is the authority)", () => {
  it("amount: required, numeric, > 0, within the refundable balance", () => {
    assert.equal(validateRefundForm("", "r", "900.00").amount, "Enter the refund amount.");
    assert.match(validateRefundForm("abc", "r", "900.00").amount!, /valid amount/);
    assert.match(validateRefundForm("1.234", "r", "900.00").amount!, /valid amount/);
    assert.match(validateRefundForm("0", "r", "900.00").amount!, /greater than 0/);
    assert.match(validateRefundForm("-5", "r", "900.00").amount!, /valid amount/);
    assert.match(validateRefundForm("900.01", "r", "900.00").amount!, /At most 900\.00/);
    assert.deepEqual(validateRefundForm("900.00", "r", "900.00"), {});
    assert.deepEqual(validateRefundForm("0.01", "r", "900.00"), {});
  });
  it("reason: required and trimmed", () => {
    assert.equal(validateRefundForm("10", "   ", "900.00").reason, "A reason is required.");
    assert.equal(validateRefundForm("10", "x".repeat(1001), "900.00").reason?.includes("at most"), true);
  });
});

describe("who sees what", () => {
  it("requester roles and approver roles", () => {
    for (const r of ["SALESPERSON", "MANAGER", "ADMIN"]) assert.ok(canRequestRefund(r));
    assert.ok(!canRequestRefund(undefined));
    assert.ok(isApprover("MANAGER") && isApprover("ADMIN") && !isApprover("SALESPERSON"));
  });
  it("Approve/Reject: approvers only, PENDING only, never on your own request", () => {
    const pending = request();
    assert.ok(canDecide("MANAGER", "u-mgr", pending));
    assert.ok(canDecide("ADMIN", "u-admin", pending));
    assert.ok(!canDecide("SALESPERSON", "u-other", pending));
    assert.ok(!canDecide("MANAGER", "u-sales", pending), "the requester is never offered the decision");
    assert.ok(!canDecide("MANAGER", "u-mgr", request({ status: "APPROVED" })));
    assert.ok(!canDecide("ADMIN", "u-admin", request({ status: "REJECTED" })));
    assert.ok(!canDecide("MANAGER", undefined, pending));
  });
});

describe("Request Refund (order detail)", () => {
  const info = (payments: RefundablePaymentView[], requests: RefundRequestView[] = []): OrderRefundInfo => ({ payments, requests });
  const render = (i: OrderRefundInfo, role: string | undefined) => renderToStaticMarkup(<OrderRefundSectionBody info={i} role={role} onRequest={() => {}} />);

  it("an eligible Cashfree payment shows the balance and a Request Refund button to every requester role", () => {
    for (const role of ["SALESPERSON", "MANAGER", "ADMIN"]) {
      const h = render(info([payment()]), role);
      assert.match(h, /Request Refund/, role);
      assert.match(text(h), /Refundable now: ₹900\.00 · already refunded ₹100\.00/);
    }
  });
  it("an ineligible payment says WHY and offers no button (no silent fallback to another provider)", () => {
    const h = render(info([payment({ eligible: false, ineligibleReason: "This payment was not collected through Cashfree, so a refund cannot be requested for it here." })]), "SALESPERSON");
    assert.doesNotMatch(h, /Request Refund/);
    assert.match(text(h), /Refund unavailable: This payment was not collected through Cashfree/);
  });
  it("no button without a recognised requester role", () => {
    assert.doesNotMatch(render(info([payment()]), undefined), /Request Refund/);
  });
  it("always states that approval is not a refund", () => {
    assert.match(text(render(info([payment()]), "SALESPERSON")), new RegExp(APPROVAL_DISCLAIMER.replace(/[.]/g, "\\.")));
  });
});

describe("request status display: approval is never shown as a refund", () => {
  const row = (r: RefundRequestView) => text(renderToStaticMarkup(<ul><RefundRequestRow request={r} /></ul>));
  it("pending", () => {
    const t = row(request());
    assert.match(t, /Pending approval/);
    assert.match(t, /Waiting for a manager or admin/);
    assert.doesNotMatch(t, /Refunded/i);
  });
  it("approved: 'Approved — refund has not been issued yet.' and nothing that says refunded", () => {
    const t = row(request({ status: "APPROVED", decidedBy: { id: "m", name: "Mgr", role: "MANAGER" }, decisionAt: "2026-10-06T11:00:00.000Z", decisionNote: "ok" }));
    assert.match(t, /Approved — refund has not been issued yet\./);
    assert.match(t, /Approved by Mgr/);
    assert.doesNotMatch(t, /Refunded/);
  });
  it("rejected shows who and why", () => {
    const t = row(request({ status: "REJECTED", decidedBy: { id: "m", name: "Mgr", role: "MANAGER" }, decisionAt: "2026-10-06T11:00:00.000Z", decisionNote: "Outside the return window" }));
    assert.match(t, /Rejected/);
    assert.match(t, /Rejected by Mgr/);
    assert.match(t, /Outside the return window/);
  });
});

describe("refund request form", () => {
  const form = (errors = {}, values = { amount: "", reason: "" }) => renderToStaticMarkup(<RefundRequestForm orderNumber="CRM-1" payment={payment({ reservedAmount: "50.00" })} values={values} errors={errors} onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} />);
  it("shows order, payment, already refunded, held by open requests and the currently refundable amount", () => {
    const t = text(form());
    assert.match(t, /Order CRM-1/);
    assert.match(t, /Payment amount ₹1,000\.00/);
    assert.match(t, /Already refunded ₹100\.00/);
    assert.match(t, /Held by open requests ₹50\.00/);
    assert.match(t, /Currently refundable ₹900\.00/);
  });
  it("the action is 'Submit Refund Request' - never Refund Now / Process / Issue - and warns that approval is required", () => {
    const t = text(form());
    assert.match(t, /Submit Refund Request/);
    assert.doesNotMatch(t, /Refund Now|Process Refund|Issue Refund/i);
    assert.match(t, /A manager or admin must approve it before a refund can be executed/);
  });
  it("shows the amount and reason errors", () => {
    const t = text(form({ amount: "Enter the refund amount.", reason: "A reason is required." }));
    assert.match(t, /Enter the refund amount\./);
    assert.match(t, /A reason is required\./);
  });
});

describe("approval queue", () => {
  const table = (items: RefundRequestView[], role: string, userId: string) => renderToStaticMarkup(<RefundQueueTable items={items} role={role} userId={userId} onApprove={() => {}} onReject={() => {}} />);
  it("shows order, customer, requester, amount, payment, reason, time and status; a manager gets Approve and Reject", () => {
    const h = table([request()], "MANAGER", "u-mgr");
    const t = text(h);
    for (const s of ["CRM-1", "Priya Shah", "Rep One", "₹250.00", "of ₹1,000.00 paid", "already refunded ₹100.00", "remaining refundable ₹650.00", "Wrong item delivered", "Pending approval"]) assert.ok(t.includes(s), s);
    assert.match(h, />Approve</);
    assert.match(h, />Reject</);
  });
  it("an admin gets the controls too", () => {
    assert.match(table([request()], "ADMIN", "u-admin"), />Approve</);
  });
  it("a salesperson never gets approval controls", () => {
    const h = table([request()], "SALESPERSON", "u-other");
    assert.doesNotMatch(h, />Approve</);
    assert.doesNotMatch(h, />Reject</);
  });
  it("your own pending request shows no controls, only a note (self-approval is not offered)", () => {
    const h = table([request({ requestedBy: { id: "u-mgr", name: "Mgr", role: "MANAGER" } })], "MANAGER", "u-mgr");
    assert.doesNotMatch(h, />Approve</);
    assert.doesNotMatch(h, />Reject</);
    assert.match(text(h), /Your request — another approver decides it/);
  });
  it("decided requests have no controls and approved ones are not shown as refunded", () => {
    const h = table([request({ status: "APPROVED", decidedBy: { id: "m", name: "Mgr", role: "MANAGER" } }), request({ id: "r2", status: "REJECTED" })], "MANAGER", "u-x");
    assert.doesNotMatch(h, />Approve</);
    assert.match(text(h), /Approved — refund has not been issued yet\./);
    assert.doesNotMatch(text(h), /Refunded/);
  });
  it("an empty queue says so", () => {
    assert.match(text(table([], "MANAGER", "u")), /No refund requests here\./);
  });
});
