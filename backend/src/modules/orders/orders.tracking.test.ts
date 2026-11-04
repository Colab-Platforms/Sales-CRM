// Run with: npx tsx --test src/modules/orders/orders.tracking.test.ts
// No database, no Shiprocket: the builder is pure over the shipment rows + a (mocked) live scan list.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOrderTracking, parseProviderDate, stageOf, type TrackingShipmentInput } from "./orders.tracking.js";

const ship = (over: Partial<TrackingShipmentInput> = {}): TrackingShipmentInput => ({
  id: "s1", status: "CREATED", courier: null, trackingNumber: null, trackingUrl: null, shippedAt: null, expectedDeliveryAt: null, deliveredAt: null, returnedAt: null,
  createdAt: new Date("2026-11-01T06:00:00Z"), pickupScheduledAt: null, providerStatus: null, shiprocketOrderId: null, ...over,
});
const live = (activities: { date: string | null; status: string | null; location: string | null }[], over: Record<string, unknown> = {}) => ({ tracking: { currentStatus: activities.at(-1)?.status ?? null, trackUrl: "https://shiprocket.co/tracking/AWB1", etd: null, courierName: "Delhivery", activities, ...over } });

describe("status mapping (one table for every source)", () => {
  it("maps Shiprocket's wording to the stages, case/underscore insensitive, and never guesses an unknown one", () => {
    const cases: [string, string][] = [
      ["NEW", "SHIPMENT_CREATED"], ["AWB ASSIGNED", "AWB_ASSIGNED"], ["Pickup Scheduled", "PICKUP_SCHEDULED"], ["PICKUP_GENERATED", "PICKUP_SCHEDULED"], ["PICKED UP", "PICKED_UP"], ["Shipped", "PICKED_UP"],
      ["IN TRANSIT", "IN_TRANSIT"], ["Reached at Destination Hub", "REACHED_DESTINATION_HUB"], ["OUT FOR DELIVERY", "OUT_FOR_DELIVERY"], ["DELIVERED", "DELIVERED"],
      ["UNDELIVERED", "DELIVERY_FAILED"], ["NDR", "DELIVERY_FAILED"], ["RTO INITIATED", "RTO_INITIATED"], ["RTO IN TRANSIT", "RTO_INITIATED"], ["RTO DELIVERED", "RTO_DELIVERED"], ["CANCELED", "CANCELLED"],
      ["Something Brand New", "OTHER"],
    ];
    for (const [text, stage] of cases) assert.equal(stageOf(text), stage, text);
    assert.equal(stageOf(null), "OTHER");
  });
  it("provider dates without a zone are India time; unreadable ones are null", () => {
    assert.equal(parseProviderDate("2026-11-02 10:30:00")?.toISOString(), "2026-11-02T05:00:00.000Z");
    assert.equal(parseProviderDate("not a date"), null);
    assert.equal(parseProviderDate(null), null);
  });
});

describe("order tracking view", () => {
  it("no shipment: 'Shipment not created yet' - nothing is invented, only the real confirmation time is shown", () => {
    const t = buildOrderTracking({ confirmedAt: new Date("2026-11-01T05:00:00Z"), shipments: [] });
    assert.equal(t.state, "NOT_CREATED");
    assert.equal(t.headline, "Shipment not created yet");
    assert.deepEqual(t.shipments, []);
    assert.deepEqual(t.orderEvents.map((e) => e.label), ["Order confirmed"]);
    assert.deepEqual(buildOrderTracking({ confirmedAt: null, shipments: [] }).orderEvents, []);
  });

  it("a shipment with no AWB yet: says so, no live lookup, no tracking link, no ETA", () => {
    const t = buildOrderTracking({ confirmedAt: null, shipments: [ship()] });
    const s = t.shipments[0]!;
    assert.equal(t.headline, "Shipment created - AWB not assigned yet");
    assert.deepEqual([s.live, s.awb, s.trackingUrl, s.estimatedDelivery], ["none", null, null, null]);
    assert.deepEqual(s.events.map((e) => e.label), ["Shipment created"]);
  });

  it("a full journey from live scans: chronological order, canonical labels, location kept, latest update, provider ETA, provider tracking link", () => {
    const scans = [
      { date: "2026-11-03 18:00:00", status: "OUT FOR DELIVERY", location: "Pune" },
      { date: "2026-11-02 09:00:00", status: "PICKED UP", location: "Mumbai" },
      { date: "2026-11-03 07:00:00", status: "REACHED AT DESTINATION HUB", location: "Pune hub" },
      { date: "2026-11-02 20:00:00", status: "IN TRANSIT", location: "Mumbai" },
    ];
    const t = buildOrderTracking({ confirmedAt: new Date("2026-11-01T05:00:00Z"), shipments: [ship({ status: "OUT_FOR_DELIVERY", trackingNumber: "AWB1", shiprocketOrderId: "SR9", courier: "Delhivery", pickupScheduledAt: new Date("2026-11-01T08:00:00Z"), liveTracking: live(scans, { currentStatus: "OUT FOR DELIVERY", etd: "2026-11-04 00:00:00" }) })] });
    const s = t.shipments[0]!;
    assert.deepEqual(s.events.map((e) => e.label), ["Shipment created", "Pickup scheduled", "Picked up", "In transit", "Reached destination hub", "Out for delivery"]);
    assert.deepEqual(s.events.map((e) => e.at), [...s.events.map((e) => e.at)].sort());
    assert.equal(s.events.find((e) => e.stage === "PICKED_UP")!.location, "Mumbai");
    assert.deepEqual([s.status.stage, s.live, s.awb, s.shiprocketOrderId, s.courier], ["OUT_FOR_DELIVERY", "live", "AWB1", "SR9", "Delhivery"]);
    assert.equal(s.latestUpdateAt, "2026-11-03T12:30:00.000Z");
    assert.equal(s.estimatedDelivery, "2026-11-03T18:30:00.000Z");
    assert.equal(s.trackingUrl, "https://shiprocket.co/tracking/AWB1");
    assert.equal(t.headline, "Out for delivery");
  });

  it("delivered: no ETA is shown; the CRM's recorded delivery time fills in when the scans lack it", () => {
    const t = buildOrderTracking({ confirmedAt: null, shipments: [ship({ status: "DELIVERED", trackingNumber: "AWB1", deliveredAt: new Date("2026-11-04T09:00:00Z"), expectedDeliveryAt: new Date("2026-11-04T00:00:00Z"), liveTracking: live([{ date: "2026-11-02 09:00:00", status: "PICKED UP", location: null }], { currentStatus: "DELIVERED" }) })] });
    const s = t.shipments[0]!;
    assert.equal(s.estimatedDelivery, null);
    assert.equal(s.events.at(-1)!.label, "Delivered");
    assert.equal(s.events.at(-1)!.source, "CRM");
  });

  it("failed delivery / NDR and RTO are shown as such", () => {
    const ndr = buildOrderTracking({ confirmedAt: null, shipments: [ship({ trackingNumber: "A", liveTracking: live([{ date: "2026-11-03 10:00:00", status: "UNDELIVERED", location: null }]) })] });
    assert.equal(ndr.shipments[0]!.status.stage, "DELIVERY_FAILED");
    const rto = buildOrderTracking({ confirmedAt: null, shipments: [ship({ trackingNumber: "A", status: "IN_TRANSIT", providerStatus: "RTO INITIATED" })] });
    assert.equal(rto.shipments[0]!.status.label, "RTO initiated");
    const back = buildOrderTracking({ confirmedAt: null, shipments: [ship({ trackingNumber: "A", status: "RETURNED", returnedAt: new Date("2026-11-08T00:00:00Z"), providerStatus: "RTO DELIVERED" })] });
    assert.equal(back.shipments[0]!.status.stage, "RTO_DELIVERED");
    assert.equal(back.shipments[0]!.estimatedDelivery, null);
  });

  it("Shiprocket unreachable: the CRM's recorded data (webhook status + timestamps) is shown and the live problem is stated, not hidden", () => {
    const t = buildOrderTracking({ confirmedAt: null, shipments: [ship({ status: "IN_TRANSIT", trackingNumber: "AWB1", trackingUrl: "https://t.example/AWB1", providerStatus: "IN TRANSIT", shippedAt: new Date("2026-11-02T04:00:00Z"), expectedDeliveryAt: new Date("2026-11-05T00:00:00Z"), liveTracking: { tracking: null, error: "Could not reach Shiprocket for live tracking" } })] });
    const s = t.shipments[0]!;
    assert.deepEqual([s.live, s.liveError, s.status.stage, s.trackingUrl], ["unavailable", "Could not reach Shiprocket for live tracking", "IN_TRANSIT", "https://t.example/AWB1"]);
    assert.deepEqual(s.events.map((e) => e.label), ["Shipment created", "Picked up"]);
    assert.equal(s.estimatedDelivery, "2026-11-05T00:00:00.000Z");
  });

  it("an unmapped provider status is shown in the provider's own words; an unsafe tracking link is dropped; no ETA is invented", () => {
    const t = buildOrderTracking({ confirmedAt: null, shipments: [ship({ trackingNumber: "A", trackingUrl: "javascript:alert(1)", liveTracking: live([{ date: "2026-11-03 10:00:00", status: "Customs hold", location: null }], { trackUrl: null }) })] });
    const s = t.shipments[0]!;
    assert.equal(s.trackingUrl, null);
    assert.equal(s.status.label, "Customs hold");
    assert.equal(s.events.find((e) => e.source === "SHIPROCKET")!.label, "Customs hold");
    assert.equal(s.estimatedDelivery, null);
  });

  it("a shipment record created AFTER its real events (a Shopify fulfilment synced later) does not show a misleading 'Shipment created' row", () => {
    const t = buildOrderTracking({ confirmedAt: null, shipments: [ship({ createdAt: new Date("2026-11-04T00:00:00Z"), status: "SHIPPED", trackingNumber: "A", shippedAt: new Date("2026-11-02T04:00:00Z") })] });
    assert.deepEqual(t.shipments[0]!.events.map((e) => e.label), ["Picked up"]);
    assert.equal(t.shipments[0]!.createdAt, "2026-11-04T00:00:00.000Z", "the card still shows when the CRM recorded it");
  });

  it("exposes nothing internal: no label URL, weights, tokens or raw provider payloads in the view", () => {
    const t = buildOrderTracking({ confirmedAt: null, shipments: [ship({ trackingNumber: "A", liveTracking: live([]) })] });
    const keys = Object.keys(t.shipments[0]!).sort();
    assert.deepEqual(keys, ["awb", "courier", "createdAt", "estimatedDelivery", "events", "latestUpdateAt", "live", "liveError", "shipmentId", "shiprocketOrderId", "status", "trackingUrl"]);
  });
});
