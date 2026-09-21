import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActivitySource, ActivityType, Role } from "../../../generated/prisma/enums.js";
import { buildLeadScope } from "@/lib/leadScope.js";
import { buildAuditWhere, mapAuditEntry, orderAuditWhere, type AuditActivityInput } from "./audit.filters.js";
import { validateEntityAuditQuery, validateListAuditQuery } from "./audit.validators.js";
import type { ListAuditQuery } from "./audit.types.js";

const UUID = "0b8f4c1e-6a52-4c53-9d0a-3f1b2c4d5e6f";
const baseQuery: ListAuditQuery = { page: 1, pageSize: 20 };

function row(overrides: Partial<AuditActivityInput> = {}): AuditActivityInput {
  return {
    id: "act-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    type: ActivityType.ORDER_CREATED,
    referenceType: "Order",
    referenceId: UUID,
    leadId: "lead-1",
    title: "Order created",
    description: null,
    oldValue: null,
    newValue: { status: "CONFIRMED" },
    metadata: null,
    source: ActivitySource.SHOPIFY_SYNC,
    actorRole: null,
    actor: null,
    lead: { id: "lead-1", leadNumber: "L-1", firstName: "Priya", lastName: "Shah" },
    order: { id: UUID, orderNumber: "ORD-1", externalNumber: "#1001" },
    ...overrides,
  };
}

describe("mapAuditEntry", () => {
  it("maps entity type/id from referenceType/referenceId, and the customer from the lead", () => {
    const entry = mapAuditEntry(row());
    assert.equal(entry.entityType, "Order");
    assert.equal(entry.entityId, UUID);
    assert.equal(entry.customer?.name, "Priya Shah");
    assert.equal(entry.order?.orderNumber, "ORD-1");
    assert.deepEqual(entry.newValue, { status: "CONFIRMED" });
  });

  it("identifies a system/integration actor honestly instead of pretending to be a user", () => {
    const entry = mapAuditEntry(row({ source: ActivitySource.SHOPIFY_WEBHOOK, actor: null, actorRole: null }));
    assert.equal(entry.actor, null);
    assert.equal(entry.actorRole, null);
    assert.equal(entry.source, "SHOPIFY_WEBHOOK");
  });

  it("captures the actor and their role for a human-initiated event", () => {
    const entry = mapAuditEntry(row({ source: ActivitySource.USER, actor: { id: "u1", name: "Asha" }, actorRole: Role.SALESPERSON }));
    assert.equal(entry.actor?.name, "Asha");
    assert.equal(entry.actorRole, Role.SALESPERSON);
  });

  it("has no customer when the lead relation is unexpectedly absent", () => {
    const entry = mapAuditEntry(row({ lead: null }));
    assert.equal(entry.customer, null);
  });
});

describe("buildAuditWhere", () => {
  it("is unrestricted for an admin with no filters", () => {
    assert.deepEqual(buildAuditWhere(baseQuery, {}), {});
  });

  it("applies the lead scope", () => {
    assert.deepEqual(buildAuditWhere(baseQuery, { ownerId: UUID }), { AND: [{ lead: { ownerId: UUID } }] });
  });

  it("combines type, source, actor and date range with AND", () => {
    const where = buildAuditWhere(
      {
        ...baseQuery,
        type: ActivityType.PAYMENT_REFUNDED,
        source: ActivitySource.SHOPIFY_SYNC,
        actorId: UUID,
        dateFrom: new Date("2026-09-01T00:00:00.000Z"),
        dateTo: new Date("2026-09-30T23:59:59.999Z"),
      },
      {},
    );
    assert.deepEqual(where, {
      AND: [
        { createdAt: { gte: new Date("2026-09-01T00:00:00.000Z"), lte: new Date("2026-09-30T23:59:59.999Z") } },
        { type: ActivityType.PAYMENT_REFUNDED },
        { actorId: UUID },
        { source: ActivitySource.SHOPIFY_SYNC },
      ],
    });
  });

  it("matches an order id via orderId or the legacy Order reference", () => {
    const where = buildAuditWhere({ ...baseQuery, orderId: UUID }, {});
    assert.deepEqual(where, { AND: [{ OR: [{ orderId: UUID }, { referenceType: "Order", referenceId: UUID }] }] });
  });

  it("searches title, description, lead and order fields case-insensitively", () => {
    const where = buildAuditWhere({ ...baseQuery, search: "Priya" }, {});
    const [term] = (where.AND as { OR: Record<string, unknown>[] }[]) ?? [];
    assert.equal(term.OR.length, 7);
    assert.deepEqual(term.OR[0], { title: { contains: "Priya", mode: "insensitive" } });
  });
});

describe("orderAuditWhere", () => {
  it("matches new-style rows via orderId and legacy rows via the Order reference", () => {
    assert.deepEqual(orderAuditWhere(UUID), { OR: [{ orderId: UUID }, { referenceType: "Order", referenceId: UUID }] });
  });
});

describe("buildLeadScope (RBAC used by the audit module)", () => {
  it("lets an admin see every audit record", () => {
    assert.deepEqual(buildLeadScope(Role.ADMIN, "a1"), {});
  });

  it("limits a salesperson to leads they own", () => {
    assert.deepEqual(buildLeadScope(Role.SALESPERSON, "s1"), { ownerId: "s1" });
  });

  it("gives a manager their groups and active team members", () => {
    const team = { groupIds: ["g1"], members: [{ id: "s1", name: "A" }] };
    assert.deepEqual(buildLeadScope(Role.MANAGER, "m1", team), { OR: [{ groupId: { in: ["g1"] } }, { ownerId: { in: ["s1"] } }] });
  });
});

describe("validateListAuditQuery", () => {
  it("applies defaults", () => {
    const { error, value } = validateListAuditQuery({});
    assert.equal(error, null);
    assert.equal(value.page, 1);
    assert.equal(value.pageSize, 20);
  });

  it("accepts every audit event type, including the new E6.6 ones", () => {
    for (const type of [
      "ORDER_STATUS_CHANGED",
      "ORDER_CANCELLED",
      "PAYMENT_CREATED",
      "PAYMENT_STATUS_CHANGED",
      "PAYMENT_REFUNDED",
      "PAYMENT_MISMATCH_DETECTED",
      "SHIPMENT_CREATED",
      "SHIPMENT_STATUS_CHANGED",
      "TRACKING_UPDATED",
      "DISCOUNT_CHANGED",
    ]) {
      assert.equal(validateListAuditQuery({ type }).value.type, type);
    }
  });

  it("accepts every source", () => {
    for (const source of ["USER", "SHOPIFY_SYNC", "SHOPIFY_WEBHOOK", "SYSTEM"]) {
      assert.equal(validateListAuditQuery({ source }).value.source, source);
    }
  });

  for (const [label, query] of [
    ["unknown type", { type: "NOT_A_TYPE" }],
    ["unknown source", { source: "MARS" }],
    ["unknown reference type", { referenceType: "Whatever" }],
    ["non-uuid actorId", { actorId: "not-a-uuid" }],
    ["non-uuid orderId", { orderId: "not-a-uuid" }],
    ["dateFrom after dateTo", { dateFrom: "2026-10-01T00:00:00.000Z", dateTo: "2026-09-01T00:00:00.000Z" }],
  ] as const) {
    it(`rejects ${label}`, () => {
      assert.ok(validateListAuditQuery(query).error, `expected an error for ${JSON.stringify(query)}`);
    });
  }
});

describe("validateEntityAuditQuery", () => {
  it("applies defaults", () => {
    const { error, value } = validateEntityAuditQuery({});
    assert.equal(error, null);
    assert.equal(value.page, 1);
    assert.equal(value.pageSize, 20);
  });

  it("rejects an out-of-range pageSize", () => {
    assert.ok(validateEntityAuditQuery({ pageSize: "500" }).error);
  });
});
