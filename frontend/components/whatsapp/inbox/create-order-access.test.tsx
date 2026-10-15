// Run with: ../backend/node_modules/.bin/tsx --test components/whatsapp/inbox/create-order-access.test.tsx
// Create Order from a WhatsApp chat: the SERVER decides (scope or assignment, plus a usable phone); it does not hang on the optional Customer 360 lookup, the payment-options request or WhatsApp consent,
// and a chat that is genuinely out of scope stays blocked with a reason.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { ConversationContextPanel } from "./conversation-context-panel";
import { conversationCustomerQueryOptions } from "@/lib/api-client/queries/whatsapp-conversation.queries";
import { resolveCreateOrderAccess } from "@/lib/whatsapp-payment";
import type { Customer360 } from "@/lib/api-client/types/customers.types";

const pick = (r: { allowed: boolean; reason: string | null }) => ({ allowed: r.allowed, reason: r.reason });
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const customer = (over: Record<string, unknown> = {}) =>
  ({ profile: { leadId: "lead-1", leadNumber: "L-1", name: "Test Customer", mobile: "9819121547", email: null, source: null, owner: null }, segment: { segment: "NEW", reason: "First order", metrics: { orderCount: 0, successfulOrderCount: 0, totalPaid: "0.00", latestOrderAt: null, daysSinceLastOrder: null } }, nextBestAction: { action: "FOLLOW_UP_PAYMENT", priority: "HIGH", reason: "Follow up", recommendedChannel: "CALL", relatedOrderId: null, metrics: { outstandingAmount: "0.00" } }, paymentSummary: { orderCount: 0, totalOrderValue: "0.00", totalPaid: "0.00", totalPending: "0.00", totalFailed: "0.00", totalRefunded: "0.00", totalOutstanding: "0.00", successfulPaymentCount: 0, pendingPaymentCount: 0, failedPaymentCount: 0, refundedPaymentCount: 0 }, latestOrder: null, currentOrderStatus: null, orders: [], shopifyCustomer: null, ...over }) as unknown as Customer360;

function panel(seed: (qc: QueryClient) => void, access: { canCreateOrder?: boolean; createOrderBlockedReason?: string | null; onRetryCreateOrderAccess?: () => void }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ConversationContextPanel leadId="lead-1" canSendWhatsApp onSendWhatsApp={() => {}} onCreateOrder={() => {}} isArchived={false} onDeleteChat={() => {}} onDeleteCustomer={() => {}} {...access} />
    </QueryClientProvider>,
  );
}
const seedData = (data: Customer360) => (qc: QueryClient) => qc.setQueryData(conversationCustomerQueryOptions("lead-1").queryKey, data);
const seedError = (status: number) => (qc: QueryClient) => {
  const q = qc.getQueryCache().build(qc, conversationCustomerQueryOptions("lead-1") as never) as unknown as { state: Record<string, unknown>; setState: (s: Record<string, unknown>) => void };
  const err = new AxiosError("failed", undefined, undefined, undefined, { status, data: { message: "failed" }, statusText: "", headers: {}, config: {} as never });
  q.setState({ ...q.state, status: "error", error: err, fetchStatus: "idle", errorUpdateCount: 1, errorUpdatedAt: Date.now() });
};
/** The opening tag + label of the button whose text starts with `label`. */
const button = (html: string, label: string) => {
  const chunk = html.split("<button").find((c) => text(c.slice(c.indexOf(">") + 1)).startsWith(label));
  assert.ok(chunk, `no "${label}" button`);
  return { disabled: /^[^>]*disabled=""/.test(chunk!), title: /title="([^"]*)"/.exec(chunk!.slice(0, chunk!.indexOf(">")))?.[1] ?? null };
};

describe("resolveCreateOrderAccess: the server's decision wins", () => {
  it("allowed by the server even when Customer 360 is unavailable or read-only (a chat assigned to me for a customer I do not own)", () => {
    assert.deepEqual(pick(resolveCreateOrderAccess({ canCreateOrder: true }, undefined)), { allowed: true, reason: null });
    assert.deepEqual(pick(resolveCreateOrderAccess({ canCreateOrder: true }, { readOnly: true })), { allowed: true, reason: null });
  });
  it("blocked by the server -> blocked with the server's reason, even if a Customer 360 record exists", () => {
    const r = resolveCreateOrderAccess({ canCreateOrder: false, createOrderBlockedReason: "This customer has no valid phone number." }, customer() as never);
    assert.deepEqual(pick(r), { allowed: false, reason: "This customer has no valid phone number." });
  });
  it("names the lead to create the order under (a sibling lead sharing the chat's phone), and falls back to the chat's own lead when none is named", () => {
    const r = resolveCreateOrderAccess({ canCreateOrder: true, orderLead: { id: "lead-mine", name: "Mine" } }, undefined);
    assert.deepEqual([r.allowed, r.orderLeadId, r.orderLeadName], [true, "lead-mine", "Mine"]);
    assert.equal(resolveCreateOrderAccess({ canCreateOrder: true }, undefined).orderLeadId, null);
  });
  it("when the access decision itself failed to load: a clear reason and a retry - never a silently disabled button", () => {
    const r = resolveCreateOrderAccess(undefined, undefined, { detailFailed: true });
    assert.equal(r.allowed, false);
    assert.equal(r.canRetry, true);
    assert.match(r.reason ?? "", /could not check whether you can create an order/);
    assert.equal(resolveCreateOrderAccess(undefined, undefined).canRetry, false, "still loading is not a failure");
    assert.equal(resolveCreateOrderAccess({ canCreateOrder: false, createOrderBlockedReason: "x" }, undefined, { detailFailed: true }).canRetry, false, "a real server answer is final");
  });
  it("an older backend (no decision sent) keeps the previous rule: an editable Customer 360 record", () => {
    assert.equal(resolveCreateOrderAccess({}, { readOnly: false }).allowed, true);
    assert.equal(resolveCreateOrderAccess(undefined, { readOnly: true }).allowed, false);
    assert.match(resolveCreateOrderAccess(undefined, { readOnly: true }).reason ?? "", /another team/);
    assert.equal(resolveCreateOrderAccess(undefined, undefined).allowed, false);
  });
});

describe("Inbox Actions: Create Order availability", () => {
  it("Customer 360 FAILED to load (server error) but the chat is eligible: Create Order is still offered and enabled", () => {
    const html = panel(seedError(500), { canCreateOrder: true });
    assert.equal(button(html, "Create Order").disabled, false);
    assert.equal(button(html, "Send WhatsApp").disabled, false);
    assert.match(text(html), /Try again/, "the customer error stays visible and recoverable");
  });
  it("a read-only customer (not mine) whose chat IS assigned to me: Create Order enabled; editing and deleting stay disabled", () => {
    const html = panel(seedData(customer({ readOnly: true })), { canCreateOrder: true });
    assert.equal(button(html, "Create Order").disabled, false);
    assert.equal(button(html, "Rename / Edit Contact").disabled, true);
    assert.equal(button(html, "Delete Customer").disabled, true);
  });
  it("genuinely out of scope: Create Order is disabled and the reason is on the button", () => {
    const reason = "This customer belongs to another team member and this chat is not assigned to you. Ask a manager or admin to assign the chat or the customer to you.";
    const b = button(panel(seedData(customer({ readOnly: true })), { canCreateOrder: false, createOrderBlockedReason: reason }), "Create Order");
    assert.equal(b.disabled, true);
    assert.equal(b.title, reason);
  });
  it("a blocked chat shows its reason in the Actions card, with Retry only when the decision failed to load", () => {
    const reason = "We could not check whether you can create an order from this chat. Retry.";
    const withRetry = text(panel(seedData(customer({ readOnly: true })), { canCreateOrder: false, createOrderBlockedReason: reason, onRetryCreateOrderAccess: () => {} }));
    assert.match(withRetry, /could not check whether you can create an order/);
    assert.match(withRetry, /Retry/);
    const final = text(panel(seedData(customer({ readOnly: true })), { canCreateOrder: false, createOrderBlockedReason: "Ask a manager or admin to assign the chat or the customer to you." }));
    assert.match(final, /Ask a manager or admin/);
    assert.doesNotMatch(final.replace(/Try again/g, ""), /\bRetry\b/);
  });
  it("no decision passed (previous behaviour): own customer enabled, read-only customer disabled", () => {
    assert.equal(button(panel(seedData(customer()), {}), "Create Order").disabled, false);
    assert.equal(button(panel(seedData(customer({ readOnly: true })), {}), "Create Order").disabled, true);
  });
});
