// Run with: ../backend/node_modules/.bin/tsx --test components/whatsapp/inbox/conversation-context-panel.test.tsx
// The right-hand Inbox panel, rendered with the conversation's customer already in the query cache (no network): every section for a real customer, an empty Orders state, the read-only
// state for another team's customer, an honest "no customer yet" state with a create action, a recoverable error that is NOT "Customer not found", and no data leaking between conversations.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { ConversationContextPanel } from "./conversation-context-panel";
import { conversationCustomerQueryOptions } from "@/lib/api-client/queries/whatsapp-conversation.queries";
import type { Customer360 } from "@/lib/api-client/types/customers.types";

const customer = (over: Partial<Customer360> = {}, profile: Partial<Customer360["profile"]> = {}): Customer360 =>
  ({
    profile: { leadId: "lead-1", leadNumber: "LEAD-MUZISKQE-6YKT", name: "test1 pip", mobile: "9819121547", email: "vinayak@gmail.com", source: { id: "s1", name: "Facebook" }, owner: { id: "u1", name: "Asha Rep" }, workingStatus: "NEW", priority: "MEDIUM", createdAt: "2026-09-01T10:00:00.000Z", lastActivityAt: "2026-10-05T10:00:00.000Z", lastContactedAt: "2026-10-04T10:00:00.000Z", ...profile },
    segment: { segment: "NEW", reason: "First order", metrics: { orderCount: 1, successfulOrderCount: 0, totalPaid: "0.00", latestOrderAt: "2026-10-05T10:00:00.000Z", daysSinceLastOrder: 3 } },
    nextBestAction: { action: "FOLLOW_UP_PAYMENT", priority: "HIGH", reason: "Payment of ₹584.10 is outstanding", recommendedChannel: "CALL", relatedOrderId: "order-1", metrics: { outstandingAmount: "584.10", totalPaid: "0.00", orderCount: 1, successfulOrderCount: 0, daysSinceLastOrder: 3 } },
    paymentSummary: { orderCount: 1, totalOrderValue: "584.10", totalPaid: "0.00", totalPending: "584.10", totalFailed: "0.00", totalRefunded: "0.00", totalOutstanding: "584.10", successfulPaymentCount: 0, pendingPaymentCount: 1, failedPaymentCount: 0, refundedPaymentCount: 0, codOrderCount: 0, codValue: "0.00", prepaidOrderCount: 1, prepaidValue: "584.10" },
    latestOrder: null,
    currentOrderStatus: "PENDING_PAYMENT",
    orders: [{ id: "order-1", orderNumber: "CRM-MV0KJP86-FHSQ", externalNumber: null, source: "SALESPERSON", createdAt: "2026-10-05T10:00:00.000Z", currency: "INR", totalAmount: "584.10", status: "PENDING_PAYMENT", paymentStatus: "PENDING", paymentMode: "PREPAID", latestShipment: null }],
    shopifyCustomer: null,
    ...over,
  }) as unknown as Customer360;

function render(leadId: string, seed: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ConversationContextPanel leadId={leadId} canSendWhatsApp onSendWhatsApp={() => {}} onCreateOrder={() => {}} isArchived={false} onDeleteChat={() => {}} onDeleteCustomer={() => {}} />
    </QueryClientProvider>,
  );
}
const seedData = (leadId: string, data: Customer360) => (qc: QueryClient) => qc.setQueryData(conversationCustomerQueryOptions(leadId).queryKey, data);
const seedError = (leadId: string, status: number, message: string) => (qc: QueryClient) => {
  const q = qc.getQueryCache().build(qc, conversationCustomerQueryOptions(leadId) as never) as unknown as { state: Record<string, unknown>; setState: (s: Record<string, unknown>) => void };
  const err = new AxiosError(message, undefined, undefined, undefined, { status, data: { message }, statusText: "", headers: {}, config: {} as never });
  q.setState({ ...q.state, status: "error", error: err, fetchStatus: "idle", errorUpdateCount: 1, errorUpdatedAt: Date.now() });
};
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("Inbox right panel: the customer behind the conversation", () => {
  it("existing lead with orders: identity, contact, source, owner, dates, Next Best Action with the outstanding payment, and the orders list all render", () => {
    const t = text(render("lead-1", seedData("lead-1", customer())));
    assert.match(t, /test1 pip/);
    assert.match(t, /9819121547/);
    assert.match(t, /vinayak@gmail\.com/);
    assert.match(t, /LEAD-MUZISKQE-6YKT/);
    assert.match(t, /Facebook/);
    assert.match(t, /Asha Rep/);
    assert.match(t, /Payment of ₹584\.10 is outstanding/);
    assert.match(t, /CRM-MV0KJP86-FHSQ/);
    assert.match(t, /584\.10/);
    assert.doesNotMatch(t, /Customer not found/i);
    assert.match(t, /Conversation Mode/, "the conversation-mode card is still there");
  });

  it("lead with no orders: the details still render and Orders shows an empty state instead of failing the panel", () => {
    const t = text(render("lead-2", seedData("lead-2", customer({ orders: [], latestOrder: null, currentOrderStatus: null }, { leadId: "lead-2", name: "Fresh Contact" }))));
    assert.match(t, /Fresh Contact/);
    assert.match(t, /9819121547/);
    assert.doesNotMatch(t, /CRM-MV0KJP86-FHSQ/);
    assert.doesNotMatch(t, /Customer not found|Could not load/i);
  });

  it("a missing optional field (no email, no source, no owner, no activity dates) does not break the panel", () => {
    const t = text(render("lead-3", seedData("lead-3", customer({}, { leadId: "lead-3", name: "Sparse Lead", email: null, source: null, owner: null, lastActivityAt: null, lastContactedAt: null }))));
    assert.match(t, /Sparse Lead/);
    assert.match(t, /9819121547/);
    assert.doesNotMatch(t, /Customer not found|Could not load/i);
  });

  it("another team's customer (readOnly): details and orders are shown with a clear view-only note", () => {
    const html = render("lead-4", seedData("lead-4", customer({ readOnly: true }, { leadId: "lead-4", name: "Other Team Customer" })));
    const t = text(html);
    assert.match(t, /Other Team Customer/);
    assert.match(t, /CRM-MV0KJP86-FHSQ/);
    assert.match(t, /belongs to another team/);
    assert.match(html, /data-testid="read-only-note"/);
  });

  it("write actions are disabled for another team's customer, and enabled for your own", () => {
    const own = render("lead-5", seedData("lead-5", customer({}, { leadId: "lead-5" })));
    const other = render("lead-6", seedData("lead-6", customer({ readOnly: true }, { leadId: "lead-6" })));
    // the opening <button ...> tag of the button whose text starts with the label
    const disabledFor = (html: string, label: string) => {
      const chunk = html.split("<button").find((c) => text(c.slice(c.indexOf(">") + 1)).startsWith(label));
      assert.ok(chunk, `button "${label}" is rendered`);
      return chunk.slice(0, chunk.indexOf(">")).includes(' disabled=""'); // not the Tailwind "disabled:" classes
    };
    assert.equal(disabledFor(own, "Create Order"), false);
    assert.equal(disabledFor(other, "Create Order"), true);
    assert.equal(disabledFor(other, "Delete Customer"), true);
    assert.equal(disabledFor(other, "Rename / Edit Contact"), true);
  });

  it("a WhatsApp contact with no CRM customer: an honest 'no customer record' state with a Create customer action - never 'Customer not found'", () => {
    const html = render("ghost", seedError("ghost", 404, "No customer is linked to this conversation"));
    const t = text(html);
    assert.match(html, /data-testid="no-customer-linked"/);
    assert.match(t, /No customer record yet/);
    assert.match(t, /Create customer/);
    assert.doesNotMatch(t, /Customer not found/i);
  });

  it("an authorization or server failure is shown as a recoverable error with Try again - never turned into 'Customer not found'", () => {
    for (const status of [403, 500]) {
      const html = render(`err-${status}`, seedError(`err-${status}`, status, `Request failed (${status})`));
      const t = text(html);
      assert.match(html, /data-testid="customer-panel-error"/);
      assert.match(t, /Try again/);
      assert.doesNotMatch(t, /Customer not found|No customer record yet/i);
    }
  });

  it("switching conversations never shows the previous customer: each panel reads only its own conversation's data", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(conversationCustomerQueryOptions("lead-a").queryKey, customer({}, { leadId: "lead-a", name: "Alpha Person" }));
    const panel = (id: string) =>
      renderToStaticMarkup(
        <QueryClientProvider client={qc}>
          <ConversationContextPanel leadId={id} canSendWhatsApp onSendWhatsApp={() => {}} onCreateOrder={() => {}} isArchived={false} onDeleteChat={() => {}} onDeleteCustomer={() => {}} />
        </QueryClientProvider>,
      );
    const a = text(panel("lead-a"));
    const b = text(panel("lead-b")); // not loaded yet: loading state, none of Alpha's data
    assert.match(a, /Alpha Person/);
    assert.doesNotMatch(b, /Alpha Person|CRM-MV0KJP86-FHSQ|9819121547/);
  });
});
