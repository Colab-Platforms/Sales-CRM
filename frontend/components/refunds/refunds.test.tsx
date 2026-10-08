// Refund APPROVAL workflow UI. Run with: ../backend/node_modules/.bin/tsx --test components/refunds/refunds.test.tsx
// (The approve confirmation and reject-reason dialogs render in a portal, which does not server-render; they are covered by the browser run.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { OrderRefundSectionBody, RefundHeaderButtons, RefundRequestRow, refundHeaderActions, type RefundRowActions } from "./order-refund-section";
import { RefundRequestForm } from "./refund-request-dialog";
import { RefundQueueTable } from "./refund-queue-view";
import { APPROVAL_DISCLAIMER, approvalCancelsOrder, approvalCopy, canDecide, canExecute, canRequestRefund, isApprover, validateRefundForm } from "@/lib/refund-status";
import type { OrderRefundInfo, RefundRequestView, RefundablePaymentView } from "@/lib/api-client/types/refunds.types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const payment = (over: Partial<RefundablePaymentView> = {}): RefundablePaymentView => ({ paymentId: "p1", method: "UPI", status: "SUCCESS", currency: "INR", amount: "1000.00", refundedAmount: "100.00", reservedAmount: "0.00", refundableAmount: "900.00", eligible: true, ineligibleReason: null, ...over });
const request = (over: Partial<RefundRequestView> = {}): RefundRequestView => ({
  id: "r1",
  orderId: "o1",
  orderNumber: "CRM-1",
  orderStatus: "CANCELLED",
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
  it("a Shopify prepaid payment whose automatic Cashfree verification has not succeeded: never Request Refund; the reason is shown with an optional retry (no 'Look up' step)", () => {
    for (const reason of ["The Cashfree payment of this Shopify order has not been verified yet, so it cannot be refunded here.", "Cashfree verification failed: This is a live payment, but the CRM is connected to the Cashfree sandbox, so it cannot be verified here."]) {
      const unresolved = payment({ eligible: false, canResolve: true, ineligibleReason: reason });
      const h = renderToStaticMarkup(<OrderRefundSectionBody info={info([unresolved])} role="SALESPERSON" onRequest={() => {}} onResolve={() => {}} />);
      assert.match(h, /Retry Cashfree verification/);
      assert.doesNotMatch(h, /Look up Cashfree details/);
      assert.doesNotMatch(h, /Request Refund/);
      assert.match(text(h), /Refund unavailable: (The Cashfree payment of this Shopify order has not been verified yet|Cashfree verification failed)/);
      assert.doesNotMatch(renderToStaticMarkup(<OrderRefundSectionBody info={info([unresolved])} role={undefined} onRequest={() => {}} onResolve={() => {}} />), /Retry Cashfree verification/);
    }
    assert.match(render(info([payment({ canResolve: false })]), "ADMIN"), /Request Refund/);
  });
  it("a Shopify payment shows when Shopify's refundable amount is what limits the refund (the dialog's maximum is the capped amount)", () => {
    const capped = payment({ amount: "820.00", refundedAmount: "0.00", refundableAmount: "300.00", shopifyRefundableAmount: "300.00", limitedByShopify: true });
    const t = text(render(info([capped]), "ADMIN"));
    assert.match(t, /Refundable now: ₹300\.00/);
    assert.match(t, /limited to what Shopify reports as refundable/);
    assert.doesNotMatch(text(render(info([payment()]), "ADMIN")), /limited to what Shopify/);
  });
  it("Shopify reporting nothing refundable: no Refund / retry button, the reason is shown", () => {
    const none = payment({ eligible: false, canResolve: false, refundableAmount: "0.00", shopifyRefundableAmount: "0.00", limitedByShopify: true, ineligibleReason: "Shopify reports nothing left to refund on this order." });
    const h = render(info([none]), "ADMIN");
    assert.doesNotMatch(h, /Request Refund|Retry Cashfree verification/);
    assert.match(text(h), /Shopify reports nothing left to refund/);
  });
  it("a fully refunded payment shows the refunded state and no Refund / lookup button", () => {
    const done = payment({ status: "REFUNDED", refundedAmount: "1000.00", refundableAmount: "0.00", eligible: false, canResolve: false, ineligibleReason: "This payment has already been fully refunded." });
    const h = renderToStaticMarkup(<OrderRefundSectionBody info={info([done])} role="ADMIN" onRequest={() => {}} onResolve={() => {}} />);
    assert.doesNotMatch(h, /Request Refund|Look up Cashfree/);
    assert.match(text(h), /already been fully refunded/);
  });
  it("no button without a recognised requester role", () => {
    assert.doesNotMatch(render(info([payment()]), undefined), /Request Refund/);
  });
  it("always states that approval is not a refund", () => {
    assert.match(text(render(info([payment()]), "SALESPERSON")), new RegExp(APPROVAL_DISCLAIMER.replace(/[.]/g, "\\.")));
  });
});

describe("Refund in the order page's top-right action area (beside Cancel Order)", () => {
  const info = (payments: RefundablePaymentView[]): OrderRefundInfo => ({ payments, requests: [] });
  const header = (i: OrderRefundInfo | undefined, role: string | undefined = "SALESPERSON") => renderToStaticMarkup(<RefundHeaderButtons actions={refundHeaderActions(i, role)} onRefund={() => {}} />);
  const ineligible = (reason: string, over: Partial<RefundablePaymentView> = {}) => payment({ eligible: false, canResolve: false, ineligibleReason: reason, ...over });

  it("Shopify-originated (CRM-synced) prepaid Cashfree paid order, #AWL101729: Refund is shown (verified ids)", () => {
    for (const role of ["SALESPERSON", "MANAGER", "ADMIN"]) {
      const h = header(info([payment({ amount: "820.00", refundedAmount: "0.00", refundableAmount: "820.00", canResolve: false })]), role);
      assert.match(text(h), /^Refund$/, role);
      assert.match(h, /header-refund-button/);
    }
  });
  it("CRM-created prepaid Cashfree paid order: Refund is shown", () => {
    assert.match(header(info([payment()])), /header-refund-button/);
  });
  it("a synced Shopify prepaid Cashfree order (CRM Order + Payment, verified automatically): Refund beside Cancel Order for SALESPERSON (telecaller), MANAGER and ADMIN; not verified -> no header button at all", () => {
    const verified = info([payment({ amount: "820.00", refundedAmount: "0.00", refundableAmount: "820.00", canResolve: false })]);
    const unverified = info([ineligible("The Cashfree payment of this Shopify order has not been verified yet, so it cannot be refunded here.", { amount: "820.00", canResolve: true })]);
    for (const role of ["SALESPERSON", "MANAGER", "ADMIN"]) {
      assert.match(header(verified, role), /header-refund-button/, role);
      assert.equal(header(unverified, role), "", role);
    }
  });
  it("COD, unpaid/failed, non-Cashfree and fully refunded orders: no Refund button at all", () => {
    const reasons = [
      ineligible("This is a cash-on-delivery payment, which is not refunded through Cashfree."),
      ineligible("Only a successful payment can be refunded (this payment is pending).", { status: "PENDING" }),
      ineligible("Only a successful payment can be refunded (this payment is failed).", { status: "FAILED" }),
      ineligible("This payment was not collected through Cashfree, so a refund cannot be requested for it here."),
      ineligible("This payment has already been fully refunded.", { status: "REFUNDED", refundedAmount: "1000.00", refundableAmount: "0.00" }),
      ineligible("The Cashfree payment id is not recorded for this payment, so it cannot be refunded."),
    ];
    for (const r of reasons) assert.equal(header(info([r])), "", r.ineligibleReason ?? "");
    assert.equal(header(info([])), "");
    assert.equal(header(undefined), "");
  });
  it("missing / failed Cashfree verification on a Shopify payment: nothing executable and no manual lookup button in the header", () => {
    for (const reason of ["The Cashfree payment of this Shopify order has not been verified yet, so it cannot be refunded here.", "Cashfree verification failed: This is a live payment, but the CRM is connected to the Cashfree sandbox, so it cannot be verified here."]) {
      const h = header(info([ineligible(reason, { canResolve: true })]));
      assert.equal(h, "");
      assert.doesNotMatch(h, /Look up Cashfree details|header-refund-button/);
    }
  });
  it("roles that cannot request refunds see neither button", () => {
    assert.equal(renderToStaticMarkup(<RefundHeaderButtons actions={refundHeaderActions(info([payment()]), undefined)} onRefund={() => {}} />), "");
    assert.equal(header(info([payment({ eligible: false, canResolve: true })]), "HR"), "");
  });
  it("several refundable payments: one labelled button each; a refundable payment wins over a lookup", () => {
    const two = refundHeaderActions(info([payment({ paymentId: "a" }), payment({ paymentId: "b", refundableAmount: "50.00" })]), "ADMIN");
    assert.deepEqual(two.map((a) => [a.kind, a.payment.paymentId]), [["refund", "a"], ["refund", "b"]]);
    assert.match(text(header(info([payment({ paymentId: "a" }), payment({ paymentId: "b", refundableAmount: "50.00" })]), "ADMIN")), /Refund ₹900\.00 Refund ₹50\.00/);
    const mixed = refundHeaderActions(info([payment({ eligible: false, canResolve: true, paymentId: "x" }), payment({ paymentId: "y" })]), "ADMIN");
    assert.deepEqual(mixed.map((a) => [a.kind, a.payment.paymentId]), [["refund", "y"]]);
  });
  it("Order Details renders the Refund action in the header action area, directly before Cancel Order (not only in the Refunds section)", () => {
    const src = readFileSync(new URL("../orders/order-detail-view.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const header = src.slice(src.indexOf("The order's action area"), src.indexOf("<h1"));
    assert.ok(header.indexOf("<OrderRefundAction") > -1 && header.indexOf("<OrderRefundAction") < header.indexOf("<CancelOrderButton"));
    assert.match(src, /<OrderRefundSection /, "the Refunds section (requests, status, completed state) stays");
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
    assert.match(t, /Original paid amount ₹1,000\.00/);
    assert.match(t, /Already refunded ₹100\.00/);
    assert.match(t, /Held by open requests ₹50\.00/);
    assert.match(t, /Currently refundable ₹900\.00/);
  });
  it("the action is 'Submit Refund Request' - never Refund Now / Process / Issue - and warns that approval is required", () => {
    const t = text(form());
    assert.match(t, /Submit Refund Request/);
    assert.doesNotMatch(t, /Refund Now|Process Refund|Issue Refund/i);
    assert.match(t, /If a manager approves it, the order is cancelled automatically and the refund can then be executed/);
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
    assert.match(text(h), /You requested this refund. Another authorized approver must approve it./);
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

import { canExecute, canRefreshExecution, refundDisplay } from "@/lib/refund-status";

describe("refund execution state display (approval is not execution)", () => {
  it("APPROVED alone, PROCESSING, COMPLETED and FAILED read differently - only a confirmed completion says completed", () => {
    assert.match(refundDisplay({ status: "APPROVED" }).note, /Approved — refund has not been issued yet\./);
    assert.equal(refundDisplay({ status: "APPROVED", executionStatus: "PROCESSING" }).label, "Refund processing");
    assert.match(refundDisplay({ status: "APPROVED", executionStatus: "PROCESSING" }).note, /Not refunded yet/);
    assert.equal(refundDisplay({ status: "APPROVED", executionStatus: "COMPLETED" }).label, "Refund completed");
    assert.equal(refundDisplay({ status: "APPROVED", executionStatus: "FAILED", failureReason: "Cashfree rejected" }).label, "Refund failed");
    assert.equal(refundDisplay({ status: "PENDING" }).label, "Pending approval");
    assert.equal(refundDisplay({ status: "REJECTED" }).label, "Rejected");
  });
  it("Execute Refund: approvers only, approved + not started/failed, never the requester's own; status check only while processing", () => {
    const r = request({ status: "APPROVED" });
    assert.ok(canExecute("MANAGER", "u-mgr", r));
    assert.ok(canExecute("ADMIN", "u-admin", { ...r, executionStatus: "FAILED" }));
    assert.ok(!canExecute("SALESPERSON", "u-x", r));
    assert.ok(!canExecute("MANAGER", "u-sales", r), "own request");
    assert.ok(!canExecute("MANAGER", "u-mgr", request({ status: "PENDING" })));
    assert.ok(!canExecute("MANAGER", "u-mgr", { ...r, executionStatus: "PROCESSING" }));
    assert.ok(!canExecute("MANAGER", "u-mgr", { ...r, executionStatus: "COMPLETED" }));
    assert.ok(canRefreshExecution("MANAGER", { ...r, executionStatus: "PROCESSING" }));
    assert.ok(!canRefreshExecution("MANAGER", r));
    assert.ok(!canRefreshExecution("SALESPERSON", { ...r, executionStatus: "PROCESSING" }));
  });
  it("the queue shows Execute Refund / Check refund status only where allowed, and never 'Refunded' for approved or processing", () => {
    const h = renderToStaticMarkup(<RefundQueueTable items={[request({ id: "a", status: "APPROVED" }), request({ id: "b", status: "APPROVED", executionStatus: "PROCESSING", cfRefundId: "CFR-9" }), request({ id: "c", status: "APPROVED", executionStatus: "COMPLETED" })]} role="MANAGER" userId="u-mgr" onApprove={() => {}} onReject={() => {}} onExecute={() => {}} onRefreshExecution={() => {}} />);
    assert.match(h, />Execute Refund</);
    assert.match(h, />Check refund status</);
    assert.match(text(h), /Refund processing/);
    assert.match(text(h), /Cashfree refund CFR-9/);
    assert.match(text(h), /Refund completed/);
    assert.equal((h.match(/>Execute Refund</g) ?? []).length, 1);
    const sales = renderToStaticMarkup(<RefundQueueTable items={[request({ status: "APPROVED" })]} role="SALESPERSON" userId="u-x" onApprove={() => {}} onReject={() => {}} onExecute={() => {}} onRefreshExecution={() => {}} />);
    assert.doesNotMatch(sales, />Execute Refund</);
  });
});

describe("refund details and actions on the order page", () => {
  const row = (r: RefundRequestView, actions?: RefundRowActions) => renderToStaticMarkup(<ul><RefundRequestRow request={r} actions={actions} /></ul>);
  const sent = (over: Partial<RefundRequestView> = {}) => request({ status: "APPROVED", decidedBy: { id: "u-mgr", name: "Manager One", role: "MANAGER" }, decisionAt: "2026-10-06T11:00:00.000Z", executionStatus: "PROCESSING", refundId: "rf0a1b2c3d4e5f", cfRefundId: "CFR-4521", providerStatus: "PENDING", executionStartedAt: "2026-10-06T12:00:00.000Z", executedBy: { id: "u-admin", name: "Admin One", role: "ADMIN" }, ...over });
  const admin: RefundRowActions = { role: "ADMIN", userId: "u-admin2", onExecute: () => {}, onRefreshExecution: () => {} };

  it("a pending refund says Pending, shows the Refund ID, Cashfree reference and status, and offers 'Check refund status' to an approver only", () => {
    const h = row(sent(), admin);
    const t = text(h);
    assert.match(t, /Refund processing/);
    assert.match(t, /Refund ID rf0a1b2c3d4e5f/);
    assert.match(t, /Cashfree reference CFR-4521/);
    assert.match(t, /Cashfree status PENDING/);
    assert.match(t, /Sent to Cashfree/);
    assert.match(h, /refund-check-status-button/);
    assert.doesNotMatch(h, /refund-execute-button/);
    assert.doesNotMatch(row(sent(), { ...admin, role: "SALESPERSON" }), /refund-check-status-button/);
    assert.match(row(sent(), { ...admin, busyId: "r1" }), /disabled=""[^>]*data-testid="refund-check-status-button"|data-testid="refund-check-status-button"[^>]*disabled=""/);
  });

  it("a successful refund shows the final state with amount, reference and completion time, and no further actions", () => {
    const h = row(sent({ executionStatus: "COMPLETED", providerStatus: "SUCCESS", executionCompletedAt: "2026-10-06T12:05:00.000Z" }), admin);
    const t = text(h);
    assert.match(t, /Refund completed/);
    assert.match(t, /₹250\.00/);
    assert.match(t, /Cashfree status SUCCESS/);
    assert.match(t, /Completed /);
    assert.match(t, /Refund ID rf0a1b2c3d4e5f/);
    assert.doesNotMatch(h, /refund-check-status-button|refund-execute-button/);
  });

  it("a failed refund shows the real reason, says no money moved and nothing is marked refunded, and offers a retry", () => {
    const h = row(sent({ executionStatus: "FAILED", providerStatus: null, failureReason: "Cashfree rejected the refund: refund amount is more than the amount available to refund" }), admin);
    assert.match(h, /refund-failure/);
    const t = text(h);
    assert.match(t, /Refund failed: Cashfree rejected the refund: refund amount is more than the amount available to refund/);
    assert.match(t, /No money was returned and the order is not marked as refunded/);
    assert.match(h, /Retry Refund/);
    assert.doesNotMatch(row(sent({ executionStatus: "COMPLETED" }), admin), /refund-failure/);
  });

  it("an approved refund that has not been sent offers 'Execute Refund' to an approver who did not raise it - never to the requester or a telecaller", () => {
    const approved = request({ status: "APPROVED", decidedBy: { id: "u-mgr", name: "Manager One", role: "MANAGER" }, executionStatus: null });
    assert.match(row(approved, admin), /Execute Refund/);
    assert.doesNotMatch(row(approved, { ...admin, userId: "u-sales" }), /refund-execute-button/, "the requester");
    assert.doesNotMatch(row(approved, { ...admin, role: "SALESPERSON" }), /refund-execute-button/);
    assert.doesNotMatch(row(request(), admin), /refund-execute-button/, "a request still waiting for approval");
    assert.doesNotMatch(row(approved), /refund-execute-button/, "no actions given (read-only view)");
  });

  it("shows when the status was last checked with Cashfree", () => {
    assert.doesNotMatch(row(sent(), admin), /Last checked/);
    const h = row(sent(), { ...admin, checkedAt: { r1: "2026-10-06T12:10:00.000Z" } });
    assert.match(text(h), /Last checked/);
    assert.match(h, /refund-last-checked/);
  });

  it("several refunds on one order are listed together (history), each with its own state", () => {
    const info: OrderRefundInfo = { payments: [payment()], requests: [sent({ id: "a", amount: "100.00", executionStatus: "COMPLETED", providerStatus: "SUCCESS" }), sent({ id: "b", amount: "50.00", refundId: "rfbbbb" }), request({ id: "c", amount: "25.00" })] };
    const h = renderToStaticMarkup(<OrderRefundSectionBody info={info} role="ADMIN" onRequest={() => {}} rowActions={admin} />);
    assert.equal((h.match(/data-testid="refund-request-row"/g) ?? []).length, 3);
    const t = text(h);
    assert.match(t, /₹100\.00/);
    assert.match(t, /₹50\.00/);
    assert.match(t, /₹25\.00/);
    assert.match(t, /Refund completed/);
    assert.match(t, /Refund processing/);
    assert.match(t, /Pending approval/);
  });

  it("the request form names the order, the customer, the original paid amount and the refundable amount", () => {
    const h = renderToStaticMarkup(<RefundRequestForm orderNumber="SHP-AWL101729" customerName="Meera Nair" payment={payment({ amount: "820.00", refundedAmount: "0.00", refundableAmount: "820.00" })} values={{ amount: "", reason: "" }} errors={{}} onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} />);
    const t = text(h);
    assert.match(t, /Order SHP-AWL101729/);
    assert.match(t, /Customer Meera Nair/);
    assert.match(t, /Original paid amount ₹820\.00/);
    assert.match(t, /Currently refundable ₹820\.00/);
    assert.match(h, /id="refund-amount"/);
    assert.match(h, /id="refund-reason"/);
    assert.doesNotMatch(text(renderToStaticMarkup(<RefundRequestForm orderNumber="X" payment={payment()} values={{ amount: "", reason: "" }} errors={{}} onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} />)), /Customer /);
  });
});

describe("the refund flow in the UI: request on an ACTIVE order; the manager's approval cancels it", () => {
  const active = (over: Partial<RefundRequestView> = {}) => request({ orderStatus: "CONFIRMED", ...over });
  const admin = { role: "ADMIN", userId: "u-admin2" };
  const approvedUnsent = (over: Partial<RefundRequestView> = {}) => request({ status: "APPROVED", decidedBy: { id: "u-mgr", name: "Manager One", role: "MANAGER" }, executionStatus: null, ...over });
  const header = (i: OrderRefundInfo, role = "SALESPERSON") => renderToStaticMarkup(<RefundHeaderButtons actions={refundHeaderActions(i, role)} onRefund={() => {}} />);

  it("an active, paid, eligible order shows Refund (the order is not cancelled), for the telecaller, manager and admin", () => {
    const info: OrderRefundInfo = { orderStatus: "CONFIRMED", payments: [payment()], requests: [] };
    for (const role of ["SALESPERSON", "MANAGER", "ADMIN"]) assert.match(header(info, role), /header-refund-button/, role);
  });

  it("after the request the header shows where the refund stands (Pending approval -> Approved -> Processing) instead of a second Refund button; a completed refund shows nothing", () => {
    const held = payment({ eligible: false, refundableAmount: "0.00", reservedAmount: "100.00", ineligibleReason: "Nothing is left to refund on this payment (it is fully refunded or fully covered by open refund requests)." });
    const h = (r: RefundRequestView) => header({ orderStatus: "CONFIRMED", payments: [held], requests: [r] });
    assert.match(text(h(active())), /Refund: Pending approval/);
    assert.match(h(active()), /header-refund-status/);
    assert.doesNotMatch(h(active()), /header-refund-button/);
    assert.match(h(active()), /disabled/);
    assert.match(text(h(approvedUnsent({ orderStatus: "CANCELLED" }))), /Refund: Approved/);
    assert.match(text(h(approvedUnsent({ orderStatus: "CANCELLED", executionStatus: "PROCESSING" }))), /Refund: Processing/);
    assert.match(text(h(approvedUnsent({ orderStatus: "CANCELLED", executionStatus: "FAILED" }))), /Refund: Failed/);
    assert.equal(h(approvedUnsent({ orderStatus: "CANCELLED", executionStatus: "COMPLETED" })), "");
    assert.equal(header({ orderStatus: "CONFIRMED", payments: [held], requests: [active()] }, "HR"), "", "roles that can not request refunds see nothing");
  });

  it("the manager is told plainly that approval cancels the order: 'Approve & Cancel Order' for an active order, plain 'Approve' once it is cancelled", () => {
    assert.equal(approvalCancelsOrder(active()), true);
    assert.equal(approvalCancelsOrder(request()), false);
    assert.equal(approvalCancelsOrder(request({ orderStatus: undefined })), false);
    const a = approvalCopy(active({ orderNumber: "CRM-77" }));
    assert.deepEqual([a.button, a.confirm], ["Approve & Cancel Order", "Approve & Cancel Order"]);
    assert.match(a.title, /cancel the order/);
    assert.match(a.warning, /will CANCEL order CRM-77/);
    assert.match(a.warning, /not approved/);
    const b = approvalCopy(request());
    assert.deepEqual([b.button, b.confirm], ["Approve", "Confirm approval"]);
    assert.doesNotMatch(b.warning, /will CANCEL/);
  });

  it("the approval queue labels the button 'Approve & Cancel Order' for an active order, 'Approve' for a cancelled one, and always keeps Reject", () => {
    const activeHtml = renderToStaticMarkup(<RefundQueueTable items={[active({ id: "b" })]} role="MANAGER" userId="u-mgr" busyId={null} onApprove={() => {}} onReject={() => {}} />);
    assert.match(text(activeHtml), /Approve & Cancel Order/);
    assert.match(activeHtml, />Reject</);
    const cancelledHtml = renderToStaticMarkup(<RefundQueueTable items={[request({ id: "a" })]} role="MANAGER" userId="u-mgr" busyId={null} onApprove={() => {}} onReject={() => {}} />);
    assert.doesNotMatch(text(cancelledHtml), /Approve & Cancel Order/);
    assert.match(cancelledHtml, />Approve</);
  });

  it("the order page shows the order's state in the refund details and says approval will cancel a not-yet-cancelled order", () => {
    const row = (r: RefundRequestView) => renderToStaticMarkup(<ul><RefundRequestRow request={r} /></ul>);
    const pending = row(active());
    assert.match(pending, /refund-approval-cancels-note/);
    assert.match(text(pending), /The order is NOT cancelled yet\. When a manager approves this refund, the order is cancelled automatically\./);
    assert.match(text(pending), /Order Not cancelled/);
    assert.match(text(pending), /Pending approval/);
    const done = row(approvedUnsent());
    assert.match(text(done), /Order Cancelled/);
    assert.match(text(done), /Approved by Manager One/);
    assert.doesNotMatch(done, /refund-approval-cancels-note/);
  });

  it("Execute is only offered once the order is cancelled (an approval cancels it); an approved refund on a non-cancelled order is not executable and says why", () => {
    assert.equal(canExecute("ADMIN", "u-admin2", approvedUnsent()), true);
    assert.equal(canExecute("ADMIN", "u-admin2", approvedUnsent({ orderStatus: "CONFIRMED" })), false);
    const h = renderToStaticMarkup(<ul><RefundRequestRow request={approvedUnsent({ orderStatus: "CONFIRMED" })} actions={{ ...admin, onExecute: () => {} }} /></ul>);
    assert.doesNotMatch(h, /refund-execute-button/);
    assert.match(text(h), /approved but its order is not cancelled, so it can not be executed/);
    assert.match(renderToStaticMarkup(<ul><RefundRequestRow request={approvedUnsent()} actions={{ ...admin, onExecute: () => {} }} /></ul>), /refund-execute-button/);
  });

  it("the request form tells the telecaller that submitting does NOT cancel the order", () => {
    const h = renderToStaticMarkup(<RefundRequestForm orderNumber="X" payment={payment()} values={{ amount: "", reason: "" }} errors={{}} onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} />);
    assert.match(text(h), /the order is NOT cancelled and no money is returned now\. If a manager approves it, the order is cancelled automatically/);
  });
});

describe("approval queue freshness", () => {
  it("polls, so a request submitted while a manager/admin already has the queue open appears without a reload", () => {
    const src = readFileSync(new URL("../../lib/api-client/queries/refunds.queries.ts", import.meta.url), "utf8");
    assert.match(src, /refundQueueQueryOptions[\s\S]*refetchInterval: \d+/);
    assert.match(src, /refundQueueQueryOptions[\s\S]*refetchOnWindowFocus: true/);
  });
});

describe("who can approve / execute (decided by the logged-in user versus the requester, never by role alone)", () => {
  const pending = (requesterId: string) => ({ status: "PENDING" as const, requestedBy: { id: requesterId } }) as never;
  it("a different manager or admin can approve a telecaller's request; the requester can not; a telecaller never can", () => {
    assert.equal(canDecide("MANAGER", "manager-b", pending("telecaller-a")), true);
    assert.equal(canDecide("ADMIN", "admin-c", pending("telecaller-a")), true);
    assert.equal(canDecide("ADMIN", "admin-a", pending("admin-a")), false); // own request
    assert.equal(canDecide("MANAGER", "manager-b", pending("manager-b")), false); // own request
    assert.equal(canDecide("MANAGER", "manager-b", pending("admin-a")), true); // an admin's request is approved by another approver
    assert.equal(canDecide("ADMIN", "admin-c", pending("manager-b")), true);
    assert.equal(canDecide("SALESPERSON", "telecaller-a", pending("someone")), false);
    assert.equal(canDecide("MANAGER", undefined, pending("telecaller-a")), false);
    assert.equal(canDecide("MANAGER", "manager-b", { status: "APPROVED", requestedBy: { id: "telecaller-a" } } as never), false); // approved: the approve action disappears
  });
  it("after approval (order cancelled) an authorized executor sees Execute Refund; not the requester, not a telecaller, not before approval", () => {
    const approved = (requesterId: string, orderStatus = "CANCELLED", executionStatus: string | null = null) => ({ status: "APPROVED" as const, requestedBy: { id: requesterId }, orderStatus, executionStatus }) as never;
    assert.equal(canExecute("MANAGER", "manager-b", approved("telecaller-a")), true);
    assert.equal(canExecute("ADMIN", "admin-c", approved("telecaller-a")), true);
    assert.equal(canExecute("ADMIN", "admin-a", approved("admin-a")), false);
    assert.equal(canExecute("SALESPERSON", "telecaller-a", approved("telecaller-a")), false);
    assert.equal(canExecute("MANAGER", "manager-b", approved("telecaller-a", "CONFIRMED")), false);
    assert.equal(canExecute("MANAGER", "manager-b", approved("telecaller-a", "CANCELLED", "COMPLETED")), false);
    assert.equal(canExecute("MANAGER", "manager-b", approved("telecaller-a", "CANCELLED", "FAILED")), true); // retry
    assert.equal(canExecute("MANAGER", "manager-b", { status: "PENDING", requestedBy: { id: "telecaller-a" }, orderStatus: "CANCELLED" } as never), false);
  });
});
