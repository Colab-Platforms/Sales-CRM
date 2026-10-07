// Test double: a tiny stateful Shopify "order" that understands exactly the operations reconcilePrepaidUpgrade uses
// (state read, order edit begin/discount/commit, manual payment) and records what was done to it, so tests can assert the
// FINANCIAL OUTCOME (total, received, outstanding, payments recorded) instead of just which calls were made.
import type { ShopifyClient } from "./shopify.client.js";

export interface FakeLine { id: string; quantity: number; unit: number } // unit in cents

export class FakeShopifyOrder {
  total: number;
  outstanding: number;
  received = 0;
  status = "PENDING";
  cancelled = false;
  readonly originalTotal: number;
  readonly orderId: string;
  readonly orderName: string;
  stagedDiscount = 0;
  committedDiscounts: number[] = [];
  paymentsRecorded: { amount: number; method: string | null }[] = [];
  markAsPaidCalls = 0;
  ordersCreated = 0;
  calls: string[] = [];
  /** Make a step fail once (userErrors) - e.g. "edit_commit", "payment", or a missing scope. */
  failNext: string | null = null;
  lines: FakeLine[];
  /** If set, a staged discount produces this total instead of total - discount (simulates tax/shipping surprises). */
  stagedTotalOverride: number | null = null;

  constructor(opts: { id?: string; name?: string; totalCents?: number; lines?: FakeLine[] } = {}) {
    this.orderId = opts.id ?? "gid://shopify/Order/5551234567";
    this.orderName = opts.name ?? "#AWL101294";
    this.total = this.originalTotal = opts.totalCents ?? 69900;
    this.outstanding = this.total;
    this.lines = opts.lines ?? [{ id: "gid://calc/line/1", quantity: 1, unit: this.total }];
  }

  private money = (cents: number) => ({ shopMoney: { amount: (cents / 100).toFixed(2) } });
  private userError = (message: string) => ({ userErrors: [{ field: null, message }] });
  private maybeFail(step: string) {
    if (this.failNext === step) {
      this.failNext = null;
      return this.userError(`Simulated Shopify failure at ${step}`);
    }
    return null;
  }

  get client(): ShopifyClient {
    return { query: async (doc: string, vars: Record<string, any> = {}) => this.handle(doc, vars) } as unknown as ShopifyClient;
  }

  private handle(doc: string, vars: Record<string, any>): unknown {
    if (doc.includes("crmPrepaidUpgradeOrderState")) {
      this.calls.push("read_order");
      return { order: { id: this.orderId, displayFinancialStatus: this.status, cancelledAt: this.cancelled ? "2026-10-05T00:00:00Z" : null, currentTotalPriceSet: this.money(this.total), totalOutstandingSet: this.money(this.outstanding), totalReceivedSet: this.money(this.received) } };
    }
    if (doc.includes("crmPrepaidUpgradeEditBegin")) {
      this.calls.push("edit_begin");
      const fail = this.maybeFail("edit_begin");
      if (fail) return { orderEditBegin: { calculatedOrder: null, ...fail } };
      this.stagedDiscount = 0;
      return { orderEditBegin: { calculatedOrder: { id: "gid://calc/1", lineItems: { nodes: this.lines.map((l) => ({ id: l.id, quantity: l.quantity, originalUnitPriceSet: this.money(l.unit) })) } }, userErrors: [] } };
    }
    if (doc.includes("crmPrepaidUpgradeEditDiscount")) {
      this.calls.push("edit_discount");
      const fail = this.maybeFail("edit_discount");
      if (fail) return { orderEditAddLineItemDiscount: { calculatedOrder: null, ...fail } };
      this.stagedDiscount = Math.round(Number(vars.discount.fixedValue.amount) * 100);
      const staged = this.stagedTotalOverride ?? this.total - this.stagedDiscount;
      return { orderEditAddLineItemDiscount: { calculatedOrder: { id: "gid://calc/1", totalPriceSet: this.money(staged), totalOutstandingSet: this.money(staged - this.received) }, userErrors: [] } };
    }
    if (doc.includes("crmPrepaidUpgradeEditCommit")) {
      this.calls.push("edit_commit");
      const fail = this.maybeFail("edit_commit");
      if (fail) return { orderEditCommit: { order: null, ...fail } };
      this.total = this.stagedTotalOverride ?? this.total - this.stagedDiscount;
      this.committedDiscounts.push(this.stagedDiscount);
      this.outstanding = this.total - this.received;
      return { orderEditCommit: { order: { id: this.orderId }, userErrors: [] } };
    }
    if (doc.includes("crmPrepaidUpgradeManualPayment")) {
      this.calls.push("payment");
      const fail = this.maybeFail("payment");
      if (fail) return { orderCreateManualPayment: { order: null, ...fail } };
      if (this.outstanding <= 0) return { orderCreateManualPayment: { order: null, ...this.userError("Order is already fully paid") } };
      this.paymentsRecorded.push({ amount: this.outstanding, method: vars.paymentMethodName ?? null });
      this.received += this.outstanding;
      this.outstanding = 0;
      this.status = "PAID";
      return { orderCreateManualPayment: { order: { id: this.orderId, displayFinancialStatus: this.status }, userErrors: [] } };
    }
    if (doc.includes("crmOrderMarkAsPaid")) {
      // The pre-existing whole-order mark-as-paid: what a converted upgrade must NEVER use.
      this.markAsPaidCalls++;
      this.paymentsRecorded.push({ amount: this.outstanding, method: "markAsPaid" });
      this.received += this.outstanding;
      this.outstanding = 0;
      this.status = "PAID";
      return { orderMarkAsPaid: { order: { id: this.orderId, displayFinancialStatus: "PAID" }, userErrors: [] } };
    }
    if (doc.includes("orderCreate")) this.ordersCreated++;
    throw new Error(`FakeShopifyOrder: unexpected operation ${doc.slice(0, 60)}`);
  }
}
