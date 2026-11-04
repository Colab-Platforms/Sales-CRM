// Run with: npx tsx --test src/modules/shiprocket/shiprocket.cancellation.test.ts   (no database, no Shiprocket - the HTTP layer is a recorded fake)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipmentStatus } from "../../../generated/prisma/enums.js";
import { ProviderHttpError } from "../integrations/integrations.common.js";
import { fakeFetch } from "../integrations/integrations.testutil.js";
import { ShiprocketClient } from "./shiprocket.client.js";
import { loadShiprocketConfig } from "./shiprocket.config.js";
import { isCancelledText, planCancellation, readShiprocketCancellation, type ShipmentForCancel } from "./shiprocket.cancellation.js";

const config = loadShiprocketConfig({ SHIPROCKET_ENABLED: "true", SHIPROCKET_EMAIL: "api@example.com", SHIPROCKET_PASSWORD: "not-real", SHIPROCKET_PICKUP_LOCATION: "warehouse" });
const login: [number, unknown] = [200, { token: "token-not-real" }];
const ship = (over: Partial<ShipmentForCancel> = {}): ShipmentForCancel => ({ status: ShipmentStatus.CREATED, providerStatus: null, providerOrderId: "9001", externalId: "5001", trackingNumber: null, ...over });

describe("what cancelling means for the shipment", () => {
  it("nothing to cancel without a Shiprocket shipment, or when creation never produced a Shiprocket order", () => {
    assert.deepEqual(planCancellation(null), { kind: "none" });
    assert.deepEqual(planCancellation(ship({ providerOrderId: null, externalId: "x", status: ShipmentStatus.CANCELLED })), { kind: "none" }, "a failed creation has no Shiprocket order");
  });
  it("a shipment still being created is reported, not cancelled by guessing an id", () => {
    assert.deepEqual(planCancellation(ship({ providerOrderId: null, externalId: "pending:abc" })), { kind: "submitting" });
  });
  it("no AWB: the order alone is cancelled, by the stored Shiprocket order id", () => {
    assert.deepEqual(planCancellation(ship()), { kind: "cancel", shiprocketOrderId: "9001", awb: null });
  });
  it("an AWB before pickup (assigned, or pickup scheduled): the courier booking is cancelled first", () => {
    for (const status of [ShipmentStatus.AWB_ASSIGNED, ShipmentStatus.PICKUP_SCHEDULED]) {
      assert.deepEqual(planCancellation(ship({ status, trackingNumber: "AWB77" })), { kind: "cancel", shiprocketOrderId: "9001", awb: "AWB77" });
    }
  });
  it("already picked up / on its way / delivered / returned: nothing is sent and the reason says why", () => {
    for (const status of [ShipmentStatus.SHIPPED, ShipmentStatus.IN_TRANSIT, ShipmentStatus.OUT_FOR_DELIVERY, ShipmentStatus.DELIVERED, ShipmentStatus.RETURNED]) {
      const plan = planCancellation(ship({ status, trackingNumber: "AWB77", providerStatus: "IN TRANSIT" }));
      assert.equal(plan.kind, "too_far", status);
      assert.match((plan as { reason: string }).reason, /can no longer cancel/);
    }
    assert.match((planCancellation(ship({ status: ShipmentStatus.SHIPPED, providerStatus: "PICKED UP" })) as { reason: string }).reason, /already PICKED UP/);
  });
  it("Shiprocket already shows it cancelled (webhook): confirmed, nothing to send", () => {
    assert.deepEqual(planCancellation(ship({ status: ShipmentStatus.CANCELLED })), { kind: "already_cancelled", shiprocketOrderId: "9001" });
  });
});

describe("only Shiprocket's own cancelled wording counts as cancelled", () => {
  it("CANCELED / Cancelled yes; requested, pending, new, empty no", () => {
    for (const t of ["CANCELED", "Cancelled", " canceled "]) assert.equal(isCancelledText(t), true, t);
    for (const t of ["CANCELLATION REQUESTED", "NEW", "READY TO SHIP", "", null, undefined]) assert.equal(isCancelledText(t), false, String(t));
  });
});

describe("the stored record", () => {
  it("reads null for an order that never had one, and reads back what was written", () => {
    assert.equal(readShiprocketCancellation({ shiprocketSync: { status: "SYNCED" } }), null);
    const r = readShiprocketCancellation({ shiprocketCancellation: { status: "FAILED", attempts: 2, shiprocketOrderId: "9001", awbCancelled: true, error: "nope" } })!;
    assert.deepEqual([r.status, r.attempts, r.shiprocketOrderId, r.awbCancelled, r.error, r.requestedAt], ["FAILED", 2, "9001", true, "nope", null]);
  });
});

describe("Shiprocket client: cancellation calls", () => {
  it("POSTs /orders/cancel with the Shiprocket order id in ids (as a number when it is one), nothing else", async () => {
    const { impl, calls } = fakeFetch([login, [200, { message: "Order cancelled successfully." }]]);
    const reply = await new ShiprocketClient(config, impl).cancelOrders(["9001"]);
    assert.equal(calls[1].url, "https://apiv2.shiprocket.in/v1/external/orders/cancel");
    assert.equal(calls[1].method, "POST");
    assert.deepEqual(calls[1].body, { ids: [9001] });
    assert.equal(reply.message, "Order cancelled successfully.");
    assert.match(reply.raw, /cancelled successfully/);
  });
  it("POSTs /orders/cancel/shipment/awbs with the AWB", async () => {
    const { impl, calls } = fakeFetch([login, [200, { message: "ok" }]]);
    await new ShiprocketClient(config, impl).cancelAwbs(["AWB77"]);
    assert.equal(calls[1].url, "https://apiv2.shiprocket.in/v1/external/orders/cancel/shipment/awbs");
    assert.deepEqual(calls[1].body, { awbs: ["AWB77"] });
  });
  it("a refusal carries Shiprocket's own text", async () => {
    const { impl } = fakeFetch([login, [400, { message: "Order cannot be cancelled as pickup is already completed" }]]);
    await assert.rejects(new ShiprocketClient(config, impl).cancelOrders(["9001"]), (e: unknown) => e instanceof ProviderHttpError && e.status === 400 && /pickup is already completed/.test(e.message));
  });
  it("a refusal inside an HTTP 200 is a refusal, not a success", async () => {
    const { impl } = fakeFetch([login, [200, { status_code: 400, message: "Shipment already in transit" }]]);
    await assert.rejects(new ShiprocketClient(config, impl).cancelOrders(["9001"]), (e: unknown) => e instanceof ProviderHttpError && /already in transit/.test(e.message));
  });
  it("reads an order's status with GET /orders/show/{id}", async () => {
    const { impl, calls } = fakeFetch([login, [200, { data: { id: 9001, status: "CANCELED" } }]]);
    assert.equal(await new ShiprocketClient(config, impl).getOrderStatus("9001"), "CANCELED");
    assert.equal(calls[1].url, "https://apiv2.shiprocket.in/v1/external/orders/show/9001");
    assert.equal(calls[1].method, "GET");
  });
});
