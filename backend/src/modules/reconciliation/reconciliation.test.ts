import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";
import { computePaymentBreakdown } from "../orders/orders.filters.js";
import {
  buildReconciliationSummary,
  buildReconciliationWhere,
  deriveReconciliationStatus,
  mapReconciliationRow,
  type ReconciliationOrderInput,
} from "./reconciliation.filters.js";
import { validateListReconciliationQuery } from "./reconciliation.validators.js";
import type { ListReconciliationQuery } from "./reconciliation.types.js";

const UUID = "0b8f4c1e-6a52-4c53-9d0a-3f1b2c4d5e6f";
const baseQuery: ListReconciliationQuery = { page: 1, pageSize: 20 };

function order(overrides: Partial<ReconciliationOrderInput> = {}): ReconciliationOrderInput {
  return {
    id: UUID,
    orderNumber: "ORD-1",
    externalNumber: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    currency: "INR",
    totalAmount: { toString: () => "1000.00" },
    discountAmount: { toString: () => "0.00" },
    lead: { id: "lead-1", leadNumber: "L-1", firstName: "Priya", lastName: "Shah" },
    payments: [],
    ...overrides,
  };
}

function payment(overrides: Partial<ReconciliationOrderInput["payments"][number]> = {}) {
  return {
    status: PaymentStatus.SUCCESS,
    method: PaymentMethod.UPI,
    amount: { toString: () => "1000.00" },
    refundedAmount: null,
    provider: "Razorpay",
    transactionReference: "TXN-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("deriveReconciliationStatus", () => {
  const cents = (rupees: string) => Math.round(Number(rupees) * 100);
  const breakdownOf = (payments: ReturnType<typeof payment>[]) => computePaymentBreakdown(payments);

  it("is PENDING when there is no payment at all", () => {
    const status = deriveReconciliationStatus(cents("1000.00"), breakdownOf([]), false);
    assert.equal(status, "PENDING");
  });

  it("is PAID when a successful payment covers the order total", () => {
    const payments = [payment({ status: PaymentStatus.SUCCESS, amount: { toString: () => "1000.00" } })];
    const status = deriveReconciliationStatus(cents("1000.00"), breakdownOf(payments), true);
    assert.equal(status, "PAID");
  });

  it("is PARTIALLY_PAID when a successful payment covers less than the order total", () => {
    const payments = [payment({ status: PaymentStatus.SUCCESS, amount: { toString: () => "500.00" } })];
    const status = deriveReconciliationStatus(cents("1000.00"), breakdownOf(payments), true);
    assert.equal(status, "PARTIALLY_PAID");
  });

  it("is PENDING when the only payment is still pending", () => {
    const payments = [payment({ status: PaymentStatus.PENDING, amount: { toString: () => "1000.00" } })];
    const status = deriveReconciliationStatus(cents("1000.00"), breakdownOf(payments), true);
    assert.equal(status, "PENDING");
  });

  it("is FAILED when every attempt failed and nothing was ever paid", () => {
    const payments = [payment({ status: PaymentStatus.FAILED, amount: { toString: () => "1000.00" } })];
    const status = deriveReconciliationStatus(cents("1000.00"), breakdownOf(payments), true);
    assert.equal(status, "FAILED");
  });

  it("is REFUNDED when a fully-paid order is fully refunded", () => {
    const payments = [
      payment({ status: PaymentStatus.REFUNDED, amount: { toString: () => "1000.00" }, refundedAmount: { toString: () => "1000.00" } }),
    ];
    const status = deriveReconciliationStatus(cents("1000.00"), breakdownOf(payments), true);
    assert.equal(status, "REFUNDED");
  });

  it("is PARTIALLY_PAID (not a mismatch) when a partial refund leaves a paid remainder", () => {
    const payments = [
      payment({
        status: PaymentStatus.PARTIALLY_REFUNDED,
        amount: { toString: () => "1000.00" },
        refundedAmount: { toString: () => "400.00" },
      }),
    ];
    const status = deriveReconciliationStatus(cents("1000.00"), breakdownOf(payments), true);
    assert.equal(status, "PARTIALLY_PAID");
  });

  it("is PAYMENT_MISMATCH when net paid exceeds the order total", () => {
    const payments = [
      payment({ status: PaymentStatus.SUCCESS, amount: { toString: () => "600.00" } }),
      payment({ status: PaymentStatus.SUCCESS, amount: { toString: () => "600.00" } }),
    ];
    const status = deriveReconciliationStatus(cents("1000.00"), breakdownOf(payments), true);
    assert.equal(status, "PAYMENT_MISMATCH");
  });

  it("is not a mismatch merely because payment information (provider/reference) is unavailable", () => {
    const payments = [payment({ status: PaymentStatus.SUCCESS, amount: { toString: () => "1000.00" }, provider: null, transactionReference: null })];
    const status = deriveReconciliationStatus(cents("1000.00"), breakdownOf(payments), true);
    assert.equal(status, "PAID");
  });
});

describe("mapReconciliationRow", () => {
  it("computes paid, refunded and outstanding for a fully paid order", () => {
    const row = mapReconciliationRow(order({ payments: [payment()] }));
    assert.equal(row.paidAmount, "1000.00");
    assert.equal(row.refundedAmount, "0.00");
    assert.equal(row.outstandingAmount, "0.00");
    assert.equal(row.reconciliationStatus, "PAID");
    assert.equal(row.customer.name, "Priya Shah");
  });

  it("computes an outstanding balance for a partially paid order", () => {
    const row = mapReconciliationRow(order({ payments: [payment({ amount: { toString: () => "300.00" } })] }));
    assert.equal(row.paidAmount, "300.00");
    assert.equal(row.outstandingAmount, "700.00");
    assert.equal(row.reconciliationStatus, "PARTIALLY_PAID");
  });

  it("surfaces the most recent payment's provider and reference", () => {
    const row = mapReconciliationRow(
      order({
        payments: [
          payment({ createdAt: new Date("2026-01-01"), provider: "Old Provider", transactionReference: "OLD" }),
          payment({ createdAt: new Date("2026-01-05"), provider: "Razorpay", transactionReference: "NEW" }),
        ],
      }),
    );
    assert.equal(row.paymentProvider, "Razorpay");
    assert.equal(row.transactionReference, "NEW");
  });

  it("has no payment provider or reference when there are no payments", () => {
    const row = mapReconciliationRow(order());
    assert.equal(row.paymentProvider, null);
    assert.equal(row.transactionReference, null);
    assert.equal(row.reconciliationStatus, "PENDING");
  });
});

describe("buildReconciliationSummary", () => {
  it("is all zero for no orders", () => {
    const summary = buildReconciliationSummary([]);
    assert.equal(summary.orderCount, 0);
    assert.equal(summary.grossOrderValue, "0.00");
    assert.equal(summary.netRevenue, "0.00");
  });

  it("aggregates gross value, net revenue and outstanding across orders", () => {
    const orders = [
      order({ totalAmount: { toString: () => "1000.00" }, payments: [payment({ amount: { toString: () => "1000.00" } })] }),
      order({
        id: "o2",
        totalAmount: { toString: () => "500.00" },
        payments: [payment({ status: PaymentStatus.PENDING, method: PaymentMethod.COD, amount: { toString: () => "500.00" } })],
      }),
      order({
        id: "o3",
        totalAmount: { toString: () => "200.00" },
        payments: [
          payment({ status: PaymentStatus.REFUNDED, amount: { toString: () => "200.00" }, refundedAmount: { toString: () => "200.00" } }),
        ],
      }),
    ];

    const summary = buildReconciliationSummary(orders);
    assert.equal(summary.orderCount, 3);
    assert.equal(summary.grossOrderValue, "1700.00");
    assert.equal(summary.successfulPayments, "1000.00");
    assert.equal(summary.pendingPayments, "500.00");
    assert.equal(summary.refundedAmount, "200.00");
    assert.equal(summary.netRevenue, "800.00");
    assert.equal(summary.outstandingAmount, "500.00");
    assert.equal(summary.codOrderCount, 1);
    assert.equal(summary.codValue, "500.00");
    // Payment mode is derived from method alone (not status), so the refunded card payment on o3
    // still counts its order as prepaid, alongside o1's UPI order.
    assert.equal(summary.prepaidOrderCount, 2);
    assert.equal(summary.prepaidValue, "1200.00");
  });
});

describe("buildReconciliationWhere", () => {
  it("is unrestricted for an admin with no filters", () => {
    assert.deepEqual(buildReconciliationWhere(baseQuery, {}), {});
  });

  it("applies the lead scope, payment status and date range", () => {
    const where = buildReconciliationWhere(
      {
        ...baseQuery,
        paymentStatus: PaymentStatus.SUCCESS,
        dateFrom: new Date("2026-09-01T00:00:00.000Z"),
        dateTo: new Date("2026-09-30T23:59:59.999Z"),
      },
      { ownerId: "u1" },
    );
    assert.deepEqual(where, {
      AND: [
        { lead: { ownerId: "u1" } },
        {
          AND: [
            { payments: { some: { status: PaymentStatus.SUCCESS } } },
            { payments: { none: { status: { in: [PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED] } } } },
          ],
        },
        { createdAt: { gte: new Date("2026-09-01T00:00:00.000Z"), lte: new Date("2026-09-30T23:59:59.999Z") } },
      ],
    });
  });

  it("filters by payment provider (contains, case-insensitive)", () => {
    const where = buildReconciliationWhere({ ...baseQuery, provider: "razorpay" }, {});
    assert.deepEqual(where, { AND: [{ payments: { some: { provider: { contains: "razorpay", mode: "insensitive" } } } }] });
  });
});

describe("validateListReconciliationQuery", () => {
  it("applies defaults", () => {
    const { error, value } = validateListReconciliationQuery({});
    assert.equal(error, null);
    assert.equal(value.page, 1);
    assert.equal(value.pageSize, 20);
  });

  it("accepts every reconciliation status", () => {
    for (const status of ["PAID", "PARTIALLY_PAID", "PENDING", "FAILED", "REFUNDED", "PAYMENT_MISMATCH"]) {
      assert.equal(validateListReconciliationQuery({ reconciliationStatus: status }).value.reconciliationStatus, status);
    }
  });

  it("accepts COD and PREPAID payment modes", () => {
    assert.equal(validateListReconciliationQuery({ paymentMode: "COD" }).value.paymentMode, "COD");
    assert.equal(validateListReconciliationQuery({ paymentMode: "PREPAID" }).value.paymentMode, "PREPAID");
  });

  for (const [label, query] of [
    ["unknown reconciliation status", { reconciliationStatus: "OVERPAID" }],
    ["unknown payment mode", { paymentMode: "CARD" }],
    ["dateFrom after dateTo", { dateFrom: "2026-10-01T00:00:00.000Z", dateTo: "2026-09-01T00:00:00.000Z" }],
  ] as const) {
    it(`rejects ${label}`, () => {
      assert.ok(validateListReconciliationQuery(query).error, `expected an error for ${JSON.stringify(query)}`);
    });
  }
});
