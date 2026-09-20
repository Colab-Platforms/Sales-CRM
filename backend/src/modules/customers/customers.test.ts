import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ActivityType,
  AssignmentType,
  OrderSource,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from "../../../generated/prisma/enums.js";
import { buildPaymentSummary, mapOrderSummary, mapProfile, scopedLeadWhere, type OrderSummaryInput } from "./customers.filters.js";
import { buildAssignmentEntries, buildInterestedEntries, buildOrderEntries, sortTimelineDesc } from "./customers.timeline.js";
import { validateCustomerIdParams, validateListTimelineQuery } from "./customers.validators.js";

const UUID = "0b8f4c1e-6a52-4c53-9d0a-3f1b2c4d5e6f";
const UUID_2 = "1c9f5d2f-7b63-5d64-ae1b-402c3d5e6f70";

function order(overrides: Partial<OrderSummaryInput> = {}): OrderSummaryInput {
  return {
    id: UUID,
    orderNumber: "ORD-1",
    externalNumber: null,
    source: OrderSource.SALESPERSON,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    currency: "INR",
    totalAmount: { toString: () => "1000.00" },
    status: OrderStatus.CONFIRMED,
    payments: [],
    shipments: [],
    ...overrides,
  };
}

describe("scopedLeadWhere", () => {
  it("looks up by id alone for an admin", () => {
    assert.deepEqual(scopedLeadWhere(UUID, {}), { id: UUID });
  });

  it("also requires the lead scope for everyone else", () => {
    assert.deepEqual(scopedLeadWhere(UUID, { ownerId: "u1" }), { AND: [{ id: UUID }, { ownerId: "u1" }] });
  });
});

describe("mapProfile", () => {
  it("joins first and last name and passes through the rest", () => {
    const profile = mapProfile({
      id: UUID,
      leadNumber: "L-1",
      firstName: "Priya",
      lastName: "Shah",
      mobile: "9876543210",
      email: "priya@example.com",
      workingStatus: "INTERESTED" as any,
      priority: "HIGH" as any,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastActivityAt: null,
      lastContactedAt: null,
      source: { id: "s1", name: "Shopify" },
      owner: { id: "u1", name: "Asha" },
    });
    assert.equal(profile.name, "Priya Shah");
    assert.equal(profile.leadId, UUID);
    assert.equal(profile.owner?.name, "Asha");
  });

  it("falls back to first name only when there is no last name", () => {
    const profile = mapProfile({
      id: UUID,
      leadNumber: "L-1",
      firstName: "Priya",
      lastName: null,
      mobile: null,
      email: null,
      workingStatus: "NEW" as any,
      priority: "MEDIUM" as any,
      createdAt: new Date(),
      lastActivityAt: null,
      lastContactedAt: null,
      source: null,
      owner: null,
    });
    assert.equal(profile.name, "Priya");
  });
});

describe("mapOrderSummary", () => {
  it("derives payment status and mode from the order's payments", () => {
    const summary = mapOrderSummary(
      order({ payments: [{ status: PaymentStatus.SUCCESS, method: PaymentMethod.UPI, amount: { toString: () => "1000.00" }, refundedAmount: null }] }),
    );
    assert.equal(summary.paymentStatus, PaymentStatus.SUCCESS);
    assert.equal(summary.paymentMode, "PREPAID");
    assert.equal(summary.totalAmount, "1000.00");
  });

  it("is null when the order has no shipment yet", () => {
    assert.equal(mapOrderSummary(order()).latestShipment, null);
  });

  it("surfaces the most recent shipment (expected to already be sorted most-recent-first)", () => {
    const summary = mapOrderSummary(
      order({
        shipments: [
          {
            id: "s2",
            status: "OUT_FOR_DELIVERY" as any,
            courier: "Delhivery",
            trackingNumber: "DL999",
            trackingUrl: "https://track.example/DL999",
            shippedAt: new Date("2026-01-02"),
            expectedDeliveryAt: null,
            deliveredAt: null,
            returnedAt: null,
            createdAt: new Date("2026-01-02"),
          },
        ],
      }),
    );
    assert.equal(summary.latestShipment?.courier, "Delhivery");
    assert.equal(summary.latestShipment?.status, "OUT_FOR_DELIVERY");
  });
});

describe("buildPaymentSummary", () => {
  it("is all zero for a customer with no orders", () => {
    const summary = buildPaymentSummary([]);
    assert.equal(summary.orderCount, 0);
    assert.equal(summary.totalOrderValue, "0.00");
    assert.equal(summary.totalPaid, "0.00");
  });

  it("sums successful, pending, failed and refunded payments independently", () => {
    const orders = [
      order({
        totalAmount: { toString: () => "500.00" },
        payments: [{ status: PaymentStatus.SUCCESS, method: PaymentMethod.CARD, amount: { toString: () => "500.00" }, refundedAmount: null }],
      }),
      order({
        id: UUID_2,
        totalAmount: { toString: () => "300.00" },
        payments: [{ status: PaymentStatus.PENDING, method: PaymentMethod.COD, amount: { toString: () => "300.00" }, refundedAmount: null }],
      }),
      order({
        totalAmount: { toString: () => "200.00" },
        payments: [{ status: PaymentStatus.FAILED, method: PaymentMethod.UPI, amount: { toString: () => "200.00" }, refundedAmount: null }],
      }),
      order({
        totalAmount: { toString: () => "100.00" },
        payments: [{ status: PaymentStatus.REFUNDED, method: PaymentMethod.CARD, amount: { toString: () => "100.00" }, refundedAmount: { toString: () => "100.00" } }],
      }),
    ];

    const summary = buildPaymentSummary(orders);
    assert.equal(summary.orderCount, 4);
    assert.equal(summary.totalOrderValue, "1100.00");
    assert.equal(summary.totalPaid, "500.00");
    assert.equal(summary.totalPending, "300.00");
    assert.equal(summary.totalFailed, "200.00");
    assert.equal(summary.totalRefunded, "100.00");
    // Pending (300) and failed (200) orders still owe their full amount; paid and fully-refunded do not.
    assert.equal(summary.totalOutstanding, "500.00");
    assert.equal(summary.successfulPaymentCount, 1);
    assert.equal(summary.pendingPaymentCount, 1);
    assert.equal(summary.failedPaymentCount, 1);
    assert.equal(summary.refundedPaymentCount, 1);
  });

  it("splits a partial refund between paid and refunded", () => {
    const orders = [
      order({
        totalAmount: { toString: () => "1000.00" },
        payments: [
          {
            status: PaymentStatus.PARTIALLY_REFUNDED,
            method: PaymentMethod.UPI,
            amount: { toString: () => "1000.00" },
            refundedAmount: { toString: () => "400.00" },
          },
        ],
      }),
    ];

    const summary = buildPaymentSummary(orders);
    assert.equal(summary.totalPaid, "600.00");
    assert.equal(summary.totalRefunded, "400.00");
    assert.equal(summary.totalOutstanding, "0.00", "the paid remainder plus the refund covers the whole order");
  });

  it("counts COD and prepaid orders and their value separately", () => {
    const orders = [
      order({
        totalAmount: { toString: () => "500.00" },
        payments: [{ status: PaymentStatus.PENDING, method: PaymentMethod.COD, amount: { toString: () => "500.00" }, refundedAmount: null }],
      }),
      order({
        totalAmount: { toString: () => "700.00" },
        payments: [{ status: PaymentStatus.SUCCESS, method: PaymentMethod.UPI, amount: { toString: () => "700.00" }, refundedAmount: null }],
      }),
    ];

    const summary = buildPaymentSummary(orders);
    assert.equal(summary.codOrderCount, 1);
    assert.equal(summary.codValue, "500.00");
    assert.equal(summary.prepaidOrderCount, 1);
    assert.equal(summary.prepaidValue, "700.00");
  });
});

describe("buildAssignmentEntries", () => {
  it("labels a first assignment and a reassignment differently", () => {
    const entries = buildAssignmentEntries([
      { id: "a1", assignmentType: AssignmentType.ROUND_ROBIN, assignedAt: new Date("2026-01-01"), user: { id: "u1", name: "Asha" }, assignedBy: null },
      { id: "a2", assignmentType: AssignmentType.REASSIGNMENT, assignedAt: new Date("2026-01-02"), user: { id: "u2", name: "Rohit" }, assignedBy: { id: "m1", name: "Manager" } },
    ]);
    assert.equal(entries[0].type, "ASSIGNMENT");
    assert.match(entries[0].title, /assigned to Asha/);
    assert.equal(entries[1].type, "REASSIGNMENT");
    assert.match(entries[1].title, /reassigned to Rohit/);
  });
});

describe("buildInterestedEntries", () => {
  it("emits a started entry, and an ended entry only when the period has ended", () => {
    const active = buildInterestedEntries([
      { id: "p1", startedAt: new Date("2026-01-01"), endedAt: null, status: "ACTIVE" as any, qualifiedBy: null },
    ]);
    assert.equal(active.length, 1);
    assert.equal(active[0].type, "INTERESTED_STARTED");

    const converted = buildInterestedEntries([
      { id: "p2", startedAt: new Date("2026-01-01"), endedAt: new Date("2026-01-05"), status: "CONVERTED" as any, qualifiedBy: null },
    ]);
    assert.equal(converted.length, 2);
    assert.equal(converted[1].type, "INTERESTED_ENDED");
  });
});

describe("buildOrderEntries", () => {
  const orderRow = {
    id: UUID,
    orderNumber: "ORD-1",
    externalNumber: "#1001",
    status: OrderStatus.DELIVERED,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    placedAt: new Date("2026-01-01T00:05:00.000Z"),
    confirmedAt: new Date("2026-01-01T00:10:00.000Z"),
    cancelledAt: null,
    shipments: [],
  };

  it("falls back to the order's own timestamps when no Activity rows exist for it", () => {
    const entries = buildOrderEntries([orderRow], []);
    const types = entries.map((e) => e.type).sort();
    assert.deepEqual(types, ["ORDER_CONFIRMED", "ORDER_CREATED", "ORDER_PLACED"]);
    assert.ok(entries.every((e) => e.order?.id === UUID));
  });

  it("does not duplicate a CREATED milestone when an Activity already recorded it", () => {
    const entries = buildOrderEntries(
      [orderRow],
      [
        {
          id: "act1",
          type: ActivityType.ORDER_CREATED,
          referenceType: "Order",
          referenceId: UUID,
          title: "Shopify order #1001 placed",
          description: null,
          createdAt: orderRow.createdAt,
          actor: null,
        },
      ],
    );
    const created = entries.filter((e) => e.type === "ORDER_CREATED");
    assert.equal(created.length, 1);
    assert.equal(created[0].source, "ACTIVITY");
  });

  it("ignores activities that belong to a different order", () => {
    const entries = buildOrderEntries(
      [orderRow],
      [
        {
          id: "act1",
          type: ActivityType.PAYMENT,
          referenceType: "Order",
          referenceId: "some-other-order",
          title: "Payment success",
          description: null,
          createdAt: new Date(),
          actor: null,
        },
      ],
    );
    assert.ok(!entries.some((e) => e.id === "act1"));
  });

  it("adds a shipped and delivered milestone for each real shipment timestamp", () => {
    const withShipment = {
      ...orderRow,
      shipments: [
        { id: "sh1", courier: "Delhivery", trackingNumber: "DL1", shippedAt: new Date("2026-01-02T00:00:00.000Z"), deliveredAt: new Date("2026-01-04T00:00:00.000Z"), returnedAt: null },
      ],
    };
    const entries = buildOrderEntries([withShipment], []);
    const shipped = entries.find((e) => e.type === "SHIPMENT_SHIPPED");
    const delivered = entries.find((e) => e.type === "SHIPMENT_DELIVERED");
    assert.ok(shipped);
    assert.match(shipped!.title, /Delhivery/);
    assert.match(shipped!.description ?? "", /DL1/);
    assert.equal(shipped!.order?.id, UUID);
    assert.ok(delivered);
    assert.equal(delivered!.occurredAt.toISOString(), "2026-01-04T00:00:00.000Z");
  });

  it("never invents a shipped/delivered/returned milestone when the shipment has no such timestamp", () => {
    const noTimestamps = { ...orderRow, shipments: [{ id: "sh2", courier: null, trackingNumber: null, shippedAt: null, deliveredAt: null, returnedAt: null }] };
    const entries = buildOrderEntries([noTimestamps], []);
    assert.ok(!entries.some((e) => e.type.startsWith("SHIPMENT_")));
  });
});

describe("sortTimelineDesc", () => {
  it("orders entries most-recent-first", () => {
    const entries = sortTimelineDesc([
      { id: "1", type: "LEAD_CREATED", title: "a", description: null, occurredAt: new Date("2026-01-01"), actor: null, order: null, source: "RECORD" },
      { id: "2", type: "LEAD_CREATED", title: "b", description: null, occurredAt: new Date("2026-03-01"), actor: null, order: null, source: "RECORD" },
      { id: "3", type: "LEAD_CREATED", title: "c", description: null, occurredAt: new Date("2026-02-01"), actor: null, order: null, source: "RECORD" },
    ]);
    assert.deepEqual(entries.map((e) => e.id), ["2", "3", "1"]);
  });
});

describe("validateCustomerIdParams", () => {
  it("accepts a uuid", () => {
    assert.equal(validateCustomerIdParams({ leadId: UUID }).error, null);
  });

  it("rejects anything else", () => {
    assert.ok(validateCustomerIdParams({ leadId: "not-a-uuid" }).error);
    assert.ok(validateCustomerIdParams({}).error);
  });
});

describe("validateListTimelineQuery", () => {
  it("applies defaults", () => {
    const { error, value } = validateListTimelineQuery({});
    assert.equal(error, null);
    assert.equal(value.page, 1);
    assert.equal(value.pageSize, 20);
  });

  it("coerces numeric strings", () => {
    assert.equal(validateListTimelineQuery({ page: "2", pageSize: "10" }).value.page, 2);
  });

  it("rejects an out-of-range pageSize", () => {
    assert.ok(validateListTimelineQuery({ pageSize: "500" }).error);
  });
});
