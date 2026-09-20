// Database integration tests for revenue & payment reconciliation. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back, so nothing is ever committed
// and it is safe to run against a shared/development database (including while the Shopify
// backfill is inserting unrelated rows elsewhere). Mirrors the pattern in customers.db-test.ts.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { OrderSource, OrderStatus, PaymentMethod, PaymentStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import ReconciliationService from "./reconciliation.service.js";

class Rollback extends Error {}

async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });

describe("Reconciliation", () => {
  it("computes summary totals and per-order reconciliation status from real orders and payments", async () => {
    await inRollback(async (tx) => {
      // Scoped to a single salesperson's own lead rather than ADMIN (unrestricted), so the assertions
      // below are exact regardless of how many real orders already exist in the shared dev database
      // (the Shopify backfill can be inserting thousands of unrelated orders at the same time).
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const source = await tx.source.create({ data: { name: "Website", code: `web-${uid()}` } });
      const lead = await tx.lead.create({
        data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", sourceId: source.id, ownerId: rep.id },
      });

      // Fully paid, prepaid.
      const paid = await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, totalAmount: "1000.00" },
      });
      await tx.payment.create({ data: { orderId: paid.id, amount: "1000.00", method: PaymentMethod.UPI, provider: "Razorpay", status: PaymentStatus.SUCCESS } });

      // Partially paid, COD.
      const partial = await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.PENDING_PAYMENT, totalAmount: "800.00" },
      });
      await tx.payment.create({ data: { orderId: partial.id, amount: "300.00", method: PaymentMethod.COD, status: PaymentStatus.SUCCESS } });

      // Fully refunded.
      const refunded = await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.REFUNDED, totalAmount: "400.00" },
      });
      await tx.payment.create({
        data: { orderId: refunded.id, amount: "400.00", method: PaymentMethod.CARD, status: PaymentStatus.REFUNDED, refundedAmount: "400.00" },
      });

      // No payment at all yet.
      await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.DRAFT, totalAmount: "150.00" },
      });

      const svc = new ReconciliationService(tx);
      const result = await svc.getReconciliation(as(rep, Role.SALESPERSON), { page: 1, pageSize: 20 });

      assert.equal(result.pagination.totalItems, 4);
      assert.equal(result.summary.orderCount, 4);
      assert.equal(result.summary.grossOrderValue, "2350.00");
      assert.equal(result.summary.successfulPayments, "1300.00");
      assert.equal(result.summary.refundedAmount, "400.00");
      assert.equal(result.summary.netRevenue, "900.00");
      // Outstanding: 500 (partial) + 150 (no payment) = 650; paid and refunded orders owe nothing more.
      assert.equal(result.summary.outstandingAmount, "650.00");
      assert.equal(result.summary.codOrderCount, 1);
      assert.equal(result.summary.codValue, "800.00");
      // Payment mode comes from method alone, so the refunded card payment's order still counts as
      // prepaid alongside the fully-paid UPI order; the order with no payment at all counts as neither.
      assert.equal(result.summary.prepaidOrderCount, 2);
      assert.equal(result.summary.prepaidValue, "1400.00");

      const byId = new Map(result.items.map((r) => [r.id, r]));
      assert.equal(byId.get(paid.id)?.reconciliationStatus, "PAID");
      assert.equal(byId.get(partial.id)?.reconciliationStatus, "PARTIALLY_PAID");
      assert.equal(byId.get(partial.id)?.outstandingAmount, "500.00");
      assert.equal(byId.get(refunded.id)?.reconciliationStatus, "REFUNDED");
      const noPaymentRow = [...byId.values()].find((r) => r.paymentStatus === null);
      assert.equal(noPaymentRow?.reconciliationStatus, "PENDING");
    });
  });

  it("filters by reconciliation status and payment mode in memory, and paginates the filtered set", async () => {
    await inRollback(async (tx) => {
      // Scoped to one salesperson's lead again, for the same reason as above - exact counts that
      // don't depend on however many real orders already exist in the shared database.
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Rohit", ownerId: rep.id } });

      for (let i = 0; i < 3; i++) {
        const order = await tx.order.create({
          data: { orderNumber: `ORD-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, totalAmount: "100.00" },
        });
        await tx.payment.create({ data: { orderId: order.id, amount: "100.00", method: PaymentMethod.UPI, status: PaymentStatus.SUCCESS } });
      }
      const codOrder = await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.PENDING_PAYMENT, totalAmount: "50.00" },
      });
      await tx.payment.create({ data: { orderId: codOrder.id, amount: "50.00", method: PaymentMethod.COD, status: PaymentStatus.PENDING } });

      const svc = new ReconciliationService(tx);

      const paidOnly = await svc.getReconciliation(as(rep, Role.SALESPERSON), { page: 1, pageSize: 2, reconciliationStatus: "PAID" });
      assert.equal(paidOnly.pagination.totalItems, 3, "3 PAID orders match even though the page size is 2");
      assert.equal(paidOnly.items.length, 2, "the page itself is capped at pageSize");
      assert.equal(paidOnly.summary.orderCount, 3, "the summary covers every matching order, not just the current page");

      const codOnly = await svc.getReconciliation(as(rep, Role.SALESPERSON), { page: 1, pageSize: 20, paymentMode: "COD" });
      assert.equal(codOnly.pagination.totalItems, 1);
      assert.equal(codOnly.items[0]?.id, codOrder.id);
    });
  });

  it("respects lead-based role scoping: a salesperson only sees their own orders in the reconciliation view", async () => {
    await inRollback(async (tx) => {
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const otherRep = await tx.user.create({ data: { name: "Other", email: `o-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const ownLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Owned", ownerId: rep.id } });
      const otherLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "NotOwned", ownerId: otherRep.id } });

      await tx.order.create({ data: { orderNumber: `ORD-${uid()}`, leadId: ownLead.id, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, totalAmount: "100.00" } });
      await tx.order.create({ data: { orderNumber: `ORD-${uid()}`, leadId: otherLead.id, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, totalAmount: "200.00" } });

      const svc = new ReconciliationService(tx);
      const result = await svc.getReconciliation(as(rep, Role.SALESPERSON), { page: 1, pageSize: 20 });
      assert.equal(result.pagination.totalItems, 1);
      assert.equal(result.summary.grossOrderValue, "100.00");
    });
  });
});
