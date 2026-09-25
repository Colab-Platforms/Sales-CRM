import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Router } from "express";
import exotelIvrRoutes from "@modules/webhooks/exotel/exotelIvr.routes.js";
import {
  extractBusinessNumber,
  extractCallerNumber,
  extractDirection,
  extractExternalEventId,
  extractIvrDigit,
  extractProviderCallId,
} from "@modules/webhooks/exotel/payloadExtractors.js";
import { resolveIvrAction, resolveIvrOption } from "@modules/webhooks/exotel/ivrOptions.js";
import { normalizePhone } from "@/utils/phone.js";
import { ExotelProvider } from "./exotel.provider.js";

/**
 * Regression: the existing Exotel IVR integration must keep working after the
 * CallerDesk / telephony additions. These use the same synthetic payload as the
 * earlier local Exotel runtime test. No database access.
 */
const EXOTEL_PAYLOAD = {
  CallSid: "TEST-RUNTIME-001",
  CallFrom: "9876543210",
  CallTo: "09513886363",
  Direction: "incoming",
  digits: "1",
};

describe("Exotel IVR integration still works", () => {
  it("extractors read the documented Exotel Passthru parameters unchanged", () => {
    assert.equal(extractProviderCallId(EXOTEL_PAYLOAD), "TEST-RUNTIME-001");
    assert.equal(extractCallerNumber(EXOTEL_PAYLOAD), "9876543210");
    assert.equal(extractBusinessNumber(EXOTEL_PAYLOAD), "09513886363");
    assert.equal(extractDirection(EXOTEL_PAYLOAD), "incoming");
    assert.equal(extractIvrDigit(EXOTEL_PAYLOAD), "1");
    assert.equal(extractIvrDigit({ digits: '"1"' }), "1", "quoted digits are still unwrapped");
    assert.equal(extractExternalEventId(EXOTEL_PAYLOAD), null, "CallSid must still never be used as an event id");
  });

  it("IVR digit mapping is unchanged", () => {
    assert.equal(resolveIvrOption("1"), "PRODUCT_INFORMATION");
    assert.equal(resolveIvrOption("2"), "ORDER_QUERY");
    assert.equal(resolveIvrOption("3"), "CUSTOMER_SUPPORT");
    assert.equal(resolveIvrOption("4"), "CALLBACK");
    assert.equal(resolveIvrOption("9"), "UNKNOWN_OPTION");
    assert.equal(resolveIvrAction("CALLBACK"), "CALLBACK_REQUESTED");
    assert.equal(resolveIvrAction(null), "NO_IVR_INPUT");
  });

  it("normalizePhone (used by the Exotel service) behaves exactly as before", () => {
    assert.equal(normalizePhone("9876543210"), "9876543210");
    assert.equal(normalizePhone("+91 98765 43210"), "9876543210");
  });

  it("the Exotel router still exposes GET /ivr (primary) and POST /ivr (dev/test)", () => {
    const routes = (exotelIvrRoutes as unknown as Router).stack
      .filter((layer) => layer.route)
      .map((layer) => ({ path: layer.route!.path, methods: Object.keys((layer.route as unknown as { methods: Record<string, boolean> }).methods) }));

    assert.deepEqual(routes, [
      { path: "/ivr", methods: ["get"] },
      { path: "/ivr", methods: ["post"] },
    ]);
  });

  it("the Exotel adapter reuses those extractors to express the event neutrally", () => {
    const result = new ExotelProvider().normalizeWebhookEvent(EXOTEL_PAYLOAD);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.event.provider, "EXOTEL");
      assert.equal(result.event.eventType, "IVR_EVENT");
      assert.equal(result.event.externalCallId, "TEST-RUNTIME-001");
      assert.equal(result.event.direction, "INBOUND");
      assert.equal(result.event.ivrDigit, "1");
      assert.equal(result.event.customerNumber, "9876543210");
      assert.equal(result.event.businessNumber, "09513886363");
      assert.equal(result.event.dedupeKey, null);
      assert.equal(result.event.status, null, "IVR events carry no call status");
    }

    assert.equal(new ExotelProvider().normalizeWebhookEvent({ CallFrom: "1" }).ok, false);
    assert.equal(new ExotelProvider().normalizeWebhookEvent(null).ok, false);
  });
});
