import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OrderSource, OrderStatus, PaymentStatus, Role } from "../../../generated/prisma/enums.js";
import { buildLeadScope } from "@/lib/leadScope.js";
import {
  PAYMENT_STATUS_PRECEDENCE,
  buildOrderWhere,
  derivePaymentStatus,
  paymentStatusWhere,
  salespersonWhere,
  scopedOrderWhere,
  searchWhere,
} from "./orders.filters.js";
import { validateListOrdersQuery, validateOrderIdParams } from "./orders.validators.js";
import type { ListOrdersQuery } from "./orders.types.js";

const UUID = "0b8f4c1e-6a52-4c53-9d0a-3f1b2c4d5e6f";
const baseQuery: ListOrdersQuery = { page: 1, pageSize: 20 };

describe("derivePaymentStatus", () => {
  const derive = (...statuses: PaymentStatus[]) => derivePaymentStatus(statuses.map((status) => ({ status })));

  it("is null when there are no payments", () => {
    assert.equal(derive(), null);
  });

  it("reads SUCCESS when a failed attempt was retried successfully", () => {
    assert.equal(derive(PaymentStatus.FAILED, PaymentStatus.SUCCESS), PaymentStatus.SUCCESS);
  });

  it("reads REFUNDED once any payment is refunded", () => {
    assert.equal(derive(PaymentStatus.SUCCESS, PaymentStatus.REFUNDED), PaymentStatus.REFUNDED);
  });

  it("ranks PENDING above FAILED", () => {
    assert.equal(derive(PaymentStatus.FAILED, PaymentStatus.PENDING), PaymentStatus.PENDING);
  });

  it("covers every payment status exactly once", () => {
    assert.deepEqual([...PAYMENT_STATUS_PRECEDENCE].sort(), Object.values(PaymentStatus).sort());
  });
});

describe("paymentStatusWhere", () => {
  it("matches orders with no payments for NONE", () => {
    assert.deepEqual(paymentStatusWhere("NONE"), { payments: { none: {} } });
  });

  it("requires the status and excludes every higher-ranked status", () => {
    assert.deepEqual(paymentStatusWhere(PaymentStatus.SUCCESS), {
      AND: [
        { payments: { some: { status: PaymentStatus.SUCCESS } } },
        { payments: { none: { status: { in: [PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED] } } } },
      ],
    });
  });

  it("only requires the status when nothing outranks it", () => {
    assert.deepEqual(paymentStatusWhere(PaymentStatus.REFUNDED), {
      AND: [{ payments: { some: { status: PaymentStatus.REFUNDED } } }],
    });
  });
});

describe("searchWhere", () => {
  it("requires every word to match", () => {
    const where = searchWhere("priya ORD-1001");
    assert.equal((where.AND as unknown[]).length, 2);
  });

  it("caps the number of words", () => {
    const where = searchWhere("a b c d e f g");
    assert.equal((where.AND as unknown[]).length, 5);
  });

  it("searches order number, customer fields and payment reference case-insensitively", () => {
    const [term] = searchWhere("Priya").AND as { OR: Record<string, unknown>[] }[];
    assert.equal(term.OR.length, 7);
    assert.deepEqual(term.OR[0], { orderNumber: { contains: "Priya", mode: "insensitive" } });
    assert.deepEqual(term.OR[6], { payments: { some: { transactionReference: { contains: "Priya", mode: "insensitive" } } } });
  });
});

describe("salespersonWhere", () => {
  it("matches the booking user, or the lead owner when nobody booked the order", () => {
    assert.deepEqual(salespersonWhere(UUID), {
      OR: [{ createdById: UUID }, { createdById: null, lead: { ownerId: UUID } }],
    });
  });
});

describe("buildOrderWhere", () => {
  it("is unrestricted for an admin with no filters", () => {
    assert.deepEqual(buildOrderWhere(baseQuery, {}), {});
  });

  it("applies the lead scope", () => {
    assert.deepEqual(buildOrderWhere(baseQuery, { ownerId: UUID }), { AND: [{ lead: { ownerId: UUID } }] });
  });

  it("combines filters with AND", () => {
    const where = buildOrderWhere(
      {
        ...baseQuery,
        status: OrderStatus.CONFIRMED,
        source: OrderSource.WEBSITE,
        dateFrom: new Date("2026-09-01T00:00:00.000Z"),
        dateTo: new Date("2026-09-30T23:59:59.999Z"),
      },
      { ownerId: UUID },
    );
    assert.deepEqual(where.AND, [
      { lead: { ownerId: UUID } },
      { status: OrderStatus.CONFIRMED },
      { source: OrderSource.WEBSITE },
      { createdAt: { gte: new Date("2026-09-01T00:00:00.000Z"), lte: new Date("2026-09-30T23:59:59.999Z") } },
    ]);
  });
});

describe("scopedOrderWhere", () => {
  it("looks up by id alone for an admin", () => {
    assert.deepEqual(scopedOrderWhere(UUID, {}), { id: UUID });
  });

  it("also requires the lead scope for everyone else", () => {
    assert.deepEqual(scopedOrderWhere(UUID, { ownerId: "u1" }), { AND: [{ id: UUID }, { lead: { ownerId: "u1" } }] });
  });
});

describe("buildLeadScope (matches the dashboard rules)", () => {
  it("lets an admin see everything", () => {
    assert.deepEqual(buildLeadScope(Role.ADMIN, "a1"), {});
  });

  it("limits a salesperson to leads they own", () => {
    assert.deepEqual(buildLeadScope(Role.SALESPERSON, "s1"), { ownerId: "s1" });
  });

  it("gives a manager their groups and active team members", () => {
    const team = { groupIds: ["g1"], members: [{ id: "s1", name: "A" }, { id: "s2", name: "B" }] };
    assert.deepEqual(buildLeadScope(Role.MANAGER, "m1", team), {
      OR: [{ groupId: { in: ["g1"] } }, { ownerId: { in: ["s1", "s2"] } }],
    });
  });

  it("gives a manager with no team access to nothing", () => {
    assert.deepEqual(buildLeadScope(Role.MANAGER, "m1", { groupIds: [], members: [] }), {
      OR: [{ groupId: { in: [] } }, { ownerId: { in: [] } }],
    });
  });
});

describe("validateListOrdersQuery", () => {
  it("applies defaults", () => {
    const { error, value } = validateListOrdersQuery({});
    assert.equal(error, null);
    assert.equal(value.page, 1);
    assert.equal(value.pageSize, 20);
  });

  it("coerces numeric strings and ignores empty filters", () => {
    const { error, value } = validateListOrdersQuery({ page: "3", pageSize: "50", status: "", search: "" });
    assert.equal(error, null);
    assert.equal(value.page, 3);
    assert.equal(value.pageSize, 50);
    assert.equal(value.status, undefined);
    assert.equal(value.search, undefined);
  });

  it("trims the search text", () => {
    assert.equal(validateListOrdersQuery({ search: "  priya  " }).value.search, "priya");
  });

  it("accepts the NONE payment filter", () => {
    assert.equal(validateListOrdersQuery({ paymentStatus: "NONE" }).value.paymentStatus, "NONE");
  });

  it("parses date filters into Dates", () => {
    const { error, value } = validateListOrdersQuery({
      dateFrom: "2026-09-01T00:00:00.000Z",
      dateTo: "2026-09-30T23:59:59.999Z",
    });
    assert.equal(error, null);
    assert.ok(value.dateFrom instanceof Date);
    assert.ok(value.dateTo instanceof Date);
  });

  for (const [label, query] of [
    ["page 0", { page: "0" }],
    ["non-numeric page", { page: "abc" }],
    ["pageSize above 100", { pageSize: "101" }],
    ["unknown status", { status: "SHIPPED" }],
    ["unknown payment status", { paymentStatus: "PAID" }],
    ["unknown source", { source: "SHOPIFY" }],
    ["non-uuid salesperson", { salespersonId: "not-a-uuid" }],
    ["date without time", { dateFrom: "2026-09-01" }],
    ["dateFrom after dateTo", { dateFrom: "2026-10-01T00:00:00.000Z", dateTo: "2026-09-01T00:00:00.000Z" }],
    ["over-long search", { search: "x".repeat(101) }],
  ] as const) {
    it(`rejects ${label}`, () => {
      assert.ok(validateListOrdersQuery(query).error, `expected an error for ${JSON.stringify(query)}`);
    });
  }
});

describe("validateOrderIdParams", () => {
  it("accepts a uuid", () => {
    assert.equal(validateOrderIdParams({ id: UUID }).error, null);
  });

  it("rejects anything else with a clear message", () => {
    assert.equal(validateOrderIdParams({ id: "123" }).error?.message, "Invalid order id");
    assert.equal(validateOrderIdParams({}).error?.message, "Invalid order id");
  });
});
