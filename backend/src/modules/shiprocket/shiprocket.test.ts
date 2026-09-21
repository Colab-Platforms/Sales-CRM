import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import { ProviderHttpError } from "../integrations/integrations.common.js";
import { fakeFetch, memoryStore } from "../integrations/integrations.testutil.js";
import { canAdvance } from "./shiprocket.apply.js";
import { ShiprocketClient, parseAssignedAwb, parseCouriers, parseCreatedOrder, parseLabelUrl, parsePickup, parseTracking } from "./shiprocket.client.js";
import { loadShiprocketConfig, loadShiprocketWebhookConfig, ShiprocketConfigError } from "./shiprocket.config.js";
import { deliveryId, mapShiprocketStatus, parseEtd, parseShiprocketEvent, verifyShiprocketToken } from "./shiprocket.events.js";
import { buildShiprocketOrder, formatOrderDate, providerFailure } from "./shiprocket.shipments.service.js";
import { LOGIN_FAILURE_COOLDOWN_MS, RENEW_BEFORE_MS, ShiprocketTokenProvider, TOKEN_LIFETIME_MS } from "./shiprocket.token.js";
import { handleShiprocketWebhook } from "./shiprocket.webhook.handler.js";
import { eventToUpdate, processShiprocketEvent } from "./shiprocket.webhook.processor.js";

const PASSWORD = "api-user-password-not-real";
const TOKEN_A = "token-A-not-real";
const TOKEN_B = "token-B-not-real";
const ENV = { SHIPROCKET_ENABLED: "true", SHIPROCKET_EMAIL: "api@example.com", SHIPROCKET_PASSWORD: PASSWORD, SHIPROCKET_PICKUP_LOCATION: "Primary", SHIPROCKET_WEBHOOK_SECRET: "hook-token-not-real" };
const login = (token: string): [number, unknown] => [200, { token }];

describe("Shiprocket config", () => {
  it("stays off unless SHIPROCKET_ENABLED=true", () => {
    assert.throws(() => loadShiprocketConfig({ ...ENV, SHIPROCKET_ENABLED: "no" }), ShiprocketConfigError);
    assert.equal(loadShiprocketWebhookConfig({ ...ENV, SHIPROCKET_ENABLED: undefined }), null);
  });

  it("defaults to Shiprocket's production API and requires a Shiprocket host", () => {
    assert.equal(loadShiprocketConfig(ENV).baseUrl, "https://apiv2.shiprocket.in/v1/external");
    assert.throws(() => loadShiprocketConfig({ ...ENV, SHIPROCKET_API_URL: "https://evil.example.com/v1/external" }), /SHIPROCKET_API_URL/);
    assert.throws(() => loadShiprocketConfig({ ...ENV, SHIPROCKET_API_URL: "http://apiv2.shiprocket.in/v1/external" }), /SHIPROCKET_API_URL/);
    assert.throws(() => loadShiprocketConfig({ ...ENV, SHIPROCKET_API_URL: "https://shiprocket.in.evil.com" }), /SHIPROCKET_API_URL/);
  });

  it("reports problems by variable name without echoing values, and keeps the password hidden", () => {
    try {
      loadShiprocketConfig({ SHIPROCKET_ENABLED: "true", SHIPROCKET_EMAIL: "not an email", SHIPROCKET_PASSWORD: "", SHIPROCKET_PICKUP_LOCATION: "" });
      assert.fail("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      assert.match(message, /SHIPROCKET_EMAIL/);
      assert.match(message, /SHIPROCKET_PASSWORD/);
      assert.match(message, /SHIPROCKET_PICKUP_LOCATION/);
      assert.ok(!message.includes("not an email"));
    }
    const config = loadShiprocketConfig(ENV);
    assert.ok(!JSON.stringify(config).includes(PASSWORD));
    assert.equal(config.password, PASSWORD);
  });

  it("needs a webhook token - without one the webhook endpoint refuses everything", () => {
    assert.equal(loadShiprocketWebhookConfig({ ...ENV, SHIPROCKET_WEBHOOK_SECRET: "" }), null);
    assert.ok(loadShiprocketWebhookConfig(ENV));
  });
});

describe("Shiprocket token lifecycle", () => {
  const config = loadShiprocketConfig(ENV);

  it("logs in once and reuses the token", async () => {
    const { impl, calls } = fakeFetch([login(TOKEN_A)]);
    const provider = new ShiprocketTokenProvider(config, impl);
    assert.equal(await provider.getToken(), TOKEN_A);
    assert.equal(await provider.getToken(), TOKEN_A);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://apiv2.shiprocket.in/v1/external/auth/login");
    assert.deepEqual(calls[0].body, { email: "api@example.com", password: PASSWORD });
  });

  it("shares ONE login between concurrent callers", async () => {
    const { impl, calls } = fakeFetch([login(TOKEN_A)]);
    const provider = new ShiprocketTokenProvider(config, impl);
    const tokens = await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);
    assert.deepEqual(tokens, [TOKEN_A, TOKEN_A, TOKEN_A]);
    assert.equal(calls.length, 1);
  });

  it("renews the token a day before its 10 days are up", async () => {
    let now = 1_000_000;
    const { impl, calls } = fakeFetch([login(TOKEN_A), login(TOKEN_B)]);
    const provider = new ShiprocketTokenProvider(config, impl, () => now);
    assert.equal(await provider.getToken(), TOKEN_A);
    now += TOKEN_LIFETIME_MS - RENEW_BEFORE_MS - 1;
    assert.equal(await provider.getToken(), TOKEN_A);
    now += 2;
    assert.equal(await provider.getToken(), TOKEN_B);
    assert.equal(calls.length, 2);
  });

  it("does not hammer Shiprocket after a failed login", async () => {
    let now = 5_000;
    const { impl, calls } = fakeFetch([[401, { message: "Invalid email or password" }], login(TOKEN_A)]);
    const provider = new ShiprocketTokenProvider(config, impl, () => now);
    await assert.rejects(provider.getToken(), ProviderHttpError);
    await assert.rejects(provider.getToken(), ProviderHttpError); // inside the cooldown: no second call
    assert.equal(calls.length, 1);
    now += LOGIN_FAILURE_COOLDOWN_MS + 1;
    assert.equal(await provider.getToken(), TOKEN_A);
    assert.equal(calls.length, 2);
  });

  it("only drops the token that was actually rejected", async () => {
    const { impl, calls } = fakeFetch([login(TOKEN_A), login(TOKEN_B)]);
    const provider = new ShiprocketTokenProvider(config, impl);
    await provider.getToken();
    provider.invalidate("some-older-token"); // a stale caller must not evict the current token
    assert.equal(await provider.getToken(), TOKEN_A);
    provider.invalidate(TOKEN_A);
    assert.equal(await provider.getToken(), TOKEN_B);
    assert.equal(calls.length, 2);
  });

  it("never lets the password appear in an error", async () => {
    const { impl } = fakeFetch([[401, { message: `wrong password ${PASSWORD}` }]]);
    await assert.rejects(new ShiprocketTokenProvider(config, impl).getToken(), (error: unknown) => error instanceof ProviderHttpError && error.status === 401);
  });
});

describe("Shiprocket client", () => {
  const config = loadShiprocketConfig(ENV);

  it("sends the bearer token, and re-logs in once when Shiprocket answers 401", async () => {
    const { impl, calls } = fakeFetch([login(TOKEN_A), [401, { message: "Unauthenticated" }], login(TOKEN_B), [200, { label_url: "https://x/label.pdf" }]]);
    const label = await new ShiprocketClient(config, impl).generateLabel("777");
    assert.equal(label, "https://x/label.pdf");
    assert.equal(calls[1].headers.Authorization, `Bearer ${TOKEN_A}`);
    assert.equal(calls[3].headers.Authorization, `Bearer ${TOKEN_B}`);
    assert.deepEqual(calls[3].body, { shipment_id: ["777"] });
    assert.equal(calls[3].url, "https://apiv2.shiprocket.in/v1/external/courier/generate/label");
  });

  it("gives up after a second 401 instead of looping", async () => {
    const { impl, calls } = fakeFetch([login(TOKEN_A), [401, {}], login(TOKEN_B), [401, {}]]);
    await assert.rejects(new ShiprocketClient(config, impl).track("AWB1"), (e: unknown) => e instanceof ProviderHttpError && e.status === 401);
    assert.equal(calls.length, 4);
  });

  it("calls the documented endpoints", async () => {
    const { impl, calls } = fakeFetch([
      login(TOKEN_A),
      [200, { data: { available_courier_companies: [{ courier_company_id: 10, courier_name: "Delhivery", rate: 63.5, etd: "Sep 25, 2026", cod: 1 }] } }],
      [200, { response: { data: { awb_code: "AWB123", courier_company_id: 10, courier_name: "Delhivery" } } }],
      [200, { pickup_status: 1, response: { pickup_scheduled_date: "2026-09-23 10:00:00", pickup_token_number: "Reference No: 9" } }],
    ]);
    const client = new ShiprocketClient(config, impl);
    const couriers = await client.getCouriers("555");
    const awb = await client.assignAwb("777", 10);
    const pickup = await client.generatePickup("777");
    assert.equal(couriers[0].courierId, 10);
    assert.equal(awb.awb, "AWB123");
    assert.equal(pickup.tokenNumber, "Reference No: 9");
    assert.equal(calls[1].url, "https://apiv2.shiprocket.in/v1/external/courier/serviceability/?order_id=555");
    assert.equal(calls[2].url, "https://apiv2.shiprocket.in/v1/external/courier/assign/awb");
    assert.deepEqual(calls[2].body, { shipment_id: "777", courier_id: 10 });
    assert.equal(calls[3].url, "https://apiv2.shiprocket.in/v1/external/courier/generate/pickup");
  });

  it("refuses answers that do not carry what the CRM needs, rather than guessing", async () => {
    const { impl } = fakeFetch([login(TOKEN_A), [200, { status: 1 }]]);
    await assert.rejects(new ShiprocketClient(config, impl).createOrder({} as never), /did not confirm the order/);
    assert.equal(parseCreatedOrder({ order_id: 1 }), null);
    assert.equal(parseAssignedAwb({ response: { data: {} } }), null);
    assert.equal(parseLabelUrl({}), null);
  });

  it("parses the documented response shapes", () => {
    assert.deepEqual(parseCreatedOrder({ order_id: 555, shipment_id: 777, status: "NEW", awb_code: "", courier_name: "" }), { orderId: "555", shipmentId: "777", awb: null, courierName: null, courierCompanyId: null });
    assert.deepEqual(parseCouriers({ data: { available_courier_companies: [{ courier_company_id: "12", courier_name: "Ekart", freight_charge: 70, cod: 0 }, { courier_name: "no id" }] } }).map((c) => [c.courierId, c.rate, c.cod]), [[12, 70, false]]);
    assert.equal(parsePickup({ response: { pickup_scheduled_date: "2026-09-23" } }).scheduledDate, "2026-09-23");
    const tracking = parseTracking({ tracking_data: { track_status: 1, track_url: "https://t/AWB1", etd: "2026-09-26 00:00:00", shipment_track: [{ current_status: "In Transit", courier_name: "Delhivery" }], shipment_track_activities: [{ date: "d", "sr-status-label": "IN TRANSIT", location: "Pune" }] } }, "AWB1");
    assert.deepEqual([tracking?.currentStatus, tracking?.trackUrl, tracking?.activities[0].location], ["In Transit", "https://t/AWB1", "Pune"]);
    assert.equal(parseTracking({ tracking_data: { error: "Invalid AWB" } }, "X"), null);
  });
});

describe("Shiprocket webhook events", () => {
  const payload = { awb: "AWB123", current_status: "Out For Delivery", current_status_id: 17, order_id: "SHP-1001-abcd1234", sr_order_id: 555, courier_name: "Delhivery", etd: "2026-09-25 18:00:00", is_return: 0, scans: [] };

  it("authenticates with the shared x-api-key token, in constant time", () => {
    assert.ok(verifyShiprocketToken({ "x-api-key": "hook-token-not-real" }, "hook-token-not-real"));
    assert.ok(!verifyShiprocketToken({ "x-api-key": "wrong" }, "hook-token-not-real"));
    assert.ok(!verifyShiprocketToken({}, "hook-token-not-real"));
    assert.ok(!verifyShiprocketToken({ "x-api-key": "hook-token-not-real-longer" }, "hook-token-not-real"));
  });

  it("reads the tracking fields", () => {
    const event = parseShiprocketEvent(payload)!;
    assert.deepEqual([event.awb, event.currentStatus, event.srOrderId, event.channelOrderId, event.courierName, event.isReturn], ["AWB123", "Out For Delivery", "555", "SHP-1001-abcd1234", "Delhivery", false]);
    assert.equal(event.etd?.toISOString(), "2026-09-25T12:30:00.000Z"); // read as India Standard Time
    assert.equal(parseShiprocketEvent({ current_status: "Delivered" }), null); // names no shipment
    assert.equal(parseShiprocketEvent({ awb: "A", is_return: 1 })!.isReturn, true);
  });

  it("maps only unambiguous statuses and leaves the rest alone", () => {
    const cases: Array<[string, ShipmentStatus | null]> = [
      ["NEW", ShipmentStatus.CREATED],
      ["AWB Assigned", ShipmentStatus.AWB_ASSIGNED],
      ["Pickup Scheduled", ShipmentStatus.PICKUP_SCHEDULED],
      ["PICKED_UP", ShipmentStatus.SHIPPED],
      ["In Transit", ShipmentStatus.IN_TRANSIT],
      ["out-for-delivery", ShipmentStatus.OUT_FOR_DELIVERY],
      ["Delivered", ShipmentStatus.DELIVERED],
      ["RTO Delivered", ShipmentStatus.RETURNED],
      ["Canceled", ShipmentStatus.CANCELLED],
      ["RTO Initiated", null],
      ["RTO In Transit", null],
      ["Undelivered", null],
      ["Lost", null],
      ["", null],
    ];
    for (const [text, expected] of cases) assert.equal(mapShiprocketStatus(text), expected, text);
    assert.equal(mapShiprocketStatus(null), null);
  });

  it("keeps a return shipment's wording without changing the status", () => {
    const update = eventToUpdate(parseShiprocketEvent({ ...payload, current_status: "Delivered", is_return: 1 })!);
    assert.equal(update.status, null);
    assert.equal(update.providerStatus, "Delivered");
    assert.equal(eventToUpdate(parseShiprocketEvent(payload)!).status, ShipmentStatus.OUT_FOR_DELIVERY);
  });

  it("parses etd with or without a zone", () => {
    assert.equal(parseEtd("2026-09-25T00:00:00Z")?.toISOString(), "2026-09-25T00:00:00.000Z");
    assert.equal(parseEtd("garbage"), null);
    assert.equal(parseEtd(null), null);
  });
});

describe("Shiprocket shipment rules", () => {
  it("only moves a shipment forward, cancels only before pickup, and treats DELIVERED/RETURNED/CANCELLED as final", () => {
    const S = ShipmentStatus;
    assert.ok(canAdvance(S.CREATED, S.AWB_ASSIGNED));
    assert.ok(canAdvance(S.AWB_ASSIGNED, S.PICKUP_SCHEDULED));
    assert.ok(canAdvance(S.PICKUP_SCHEDULED, S.SHIPPED));
    assert.ok(canAdvance(S.SHIPPED, S.IN_TRANSIT));
    assert.ok(canAdvance(S.IN_TRANSIT, S.OUT_FOR_DELIVERY));
    assert.ok(canAdvance(S.OUT_FOR_DELIVERY, S.DELIVERED));
    assert.ok(canAdvance(S.CREATED, S.SHIPPED)); // a skipped step is fine
    assert.ok(!canAdvance(S.IN_TRANSIT, S.SHIPPED));
    assert.ok(!canAdvance(S.OUT_FOR_DELIVERY, S.IN_TRANSIT));
    assert.ok(!canAdvance(S.SHIPPED, S.SHIPPED));
    assert.ok(canAdvance(S.CREATED, S.CANCELLED));
    assert.ok(canAdvance(S.PICKUP_SCHEDULED, S.CANCELLED));
    assert.ok(!canAdvance(S.SHIPPED, S.CANCELLED));
    assert.ok(canAdvance(S.IN_TRANSIT, S.RETURNED));
    assert.ok(!canAdvance(S.CREATED, S.RETURNED));
    for (const done of [S.DELIVERED, S.RETURNED, S.CANCELLED]) {
      for (const next of Object.values(S)) assert.ok(!canAdvance(done, next), `${done} -> ${next}`);
    }
  });

  const order = (overrides: Record<string, unknown> = {}) => ({
    orderNumber: "SHP-1001",
    placedAt: new Date("2026-09-20T04:30:00Z"),
    createdAt: new Date("2026-09-20T04:00:00Z"),
    currency: "INR",
    totalAmount: "649.00",
    discountAmount: "50.00",
    shippingAmount: "49.00",
    shippingAddress: { name: "Priya Shah", address1: "12 MG Road", address2: "Flat 4", city: "Pune", province: "Maharashtra", zip: "411001", country: "India", phone: "+91 98765 00000" },
    lead: { firstName: "Priya", lastName: "Shah", mobile: "9876500000", normalizedMobile: "919876500000", email: "priya@example.com" },
    items: [{ productNameSnapshot: "Herbal Tea", variantNameSnapshot: "250g", skuSnapshot: "HT-250", quantity: 2, unitPrice: "300.00", discountAmount: "25.00", taxAmount: "0.00" }],
    payments: [] as { status: PaymentStatus; amount: string; refundedAmount: string | null }[],
    ...overrides,
  });
  const dims = { weight: 0.5, length: 10, breadth: 10, height: 5 };

  it("builds a Prepaid order when nothing is owed", () => {
    const { request, collectCents } = buildShiprocketOrder(order({ payments: [{ status: PaymentStatus.SUCCESS, amount: "649.00", refundedAmount: null }] }), dims, "Primary", "SHP-1001-abcd1234");
    assert.equal(request.payment_method, "Prepaid");
    assert.equal(collectCents, 0);
    assert.equal(request.sub_total, 649);
    assert.equal(request.order_id, "SHP-1001-abcd1234");
    assert.equal(request.pickup_location, "Primary");
    assert.equal(request.order_date, "2026-09-20 10:00"); // IST
    assert.equal(request.billing_phone, "9876500000");
    assert.deepEqual([request.billing_customer_name, request.billing_last_name], ["Priya", "Shah"]);
    assert.deepEqual(request.order_items[0], { name: "Herbal Tea - 250g", sku: "HT-250", units: 2, selling_price: 300, discount: 25, tax: 0 });
    assert.deepEqual([request.weight, request.length, request.breadth, request.height], [0.5, 10, 10, 5]);
  });

  it("collects exactly what is still unpaid on delivery", () => {
    const { request, collectCents } = buildShiprocketOrder(order({ payments: [{ status: PaymentStatus.SUCCESS, amount: "200.00", refundedAmount: null }, { status: PaymentStatus.PENDING, amount: "449.00", refundedAmount: null }] }), dims, "Primary", "X");
    assert.equal(request.payment_method, "COD");
    assert.equal(collectCents, 44900);
    assert.equal(request.sub_total, 449);
  });

  it("lists exactly what is missing instead of sending a broken order to Shiprocket", () => {
    assert.throws(
      () => buildShiprocketOrder(order({ shippingAddress: { name: "Priya", city: "Pune", zip: "4110" }, items: [] }), dims, "Primary", "X"),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /shipping address line/);
        assert.match(message, /state/);
        assert.match(message, /6-digit pincode/);
        assert.match(message, /order items/);
        assert.ok(!/\bcity\b/.test(message));
        return true;
      },
    );
  });

  it("falls back to the customer's number when the address has none", () => {
    const { request } = buildShiprocketOrder(order({ shippingAddress: { name: "Priya Shah", address1: "12 MG Road", city: "Pune", province: "MH", zip: "411001", phone: null } }), dims, "Primary", "X");
    assert.equal(request.billing_phone, "9876500000");
    assert.equal(request.billing_country, "India");
  });

  it("formats the order date in IST", () => {
    assert.equal(formatOrderDate(new Date("2026-12-31T20:00:00Z")), "2027-01-01 01:30");
  });

  it("reports a rejected request as the user's to fix, and an outage as a bad gateway", () => {
    assert.equal(providerFailure(new ProviderHttpError("SHIPROCKET", 422, "Pincode not serviceable", false), "create the shipment").statusCode, 400);
    assert.equal(providerFailure(new ProviderHttpError("SHIPROCKET", null, "x", true), "create the shipment").statusCode, 502);
    assert.equal(providerFailure(new ProviderHttpError("SHIPROCKET", 500, "x", true), "create the shipment").statusCode, 502);
    assert.equal(providerFailure(new ProviderHttpError("SHIPROCKET", 401, "x", false), "create the shipment").statusCode, 502);
    assert.equal(providerFailure(new Error("boom"), "create the shipment").statusCode, 502);
  });
});

describe("Shiprocket webhook handler", () => {
  const cfg = loadShiprocketWebhookConfig(ENV)!;
  const body = (o: unknown) => Buffer.from(JSON.stringify(o));
  const good = { awb: "AWB123", current_status: "In Transit", order_id: "SHP-1-abc", sr_order_id: 555 };
  const auth = { "x-api-key": "hook-token-not-real" };

  it("refuses without configuration or with the wrong token, recording nothing", async () => {
    const { store, rows } = memoryStore();
    const never = () => assert.fail("must not schedule");
    assert.equal((await handleShiprocketWebhook({ rawBody: body(good), headers: auth }, { config: null, store, schedule: never })).status, 503);
    assert.equal((await handleShiprocketWebhook({ rawBody: body(good), headers: { "x-api-key": "nope" } }, { config: cfg, store, schedule: never })).status, 401);
    assert.equal((await handleShiprocketWebhook({ rawBody: body(good), headers: {} }, { config: cfg, store, schedule: never })).status, 401);
    assert.equal((await handleShiprocketWebhook({ rawBody: Buffer.from("nope"), headers: auth }, { config: cfg, store, schedule: never })).status, 400);
    assert.equal(rows.length, 0);
  });

  it("records a delivery once and schedules it once - a repeat is harmless", async () => {
    const { store, rows } = memoryStore();
    const scheduled: string[] = [];
    const request = { rawBody: body(good), headers: auth };
    assert.equal((await handleShiprocketWebhook(request, { config: cfg, store, schedule: (id) => scheduled.push(id) })).status, 200);
    assert.match((await handleShiprocketWebhook(request, { config: cfg, store, schedule: (id) => scheduled.push(id) })).message, /duplicate/i);
    assert.equal(rows.length, 1);
    assert.equal(scheduled.length, 1);
    assert.equal(rows[0].externalEventId, deliveryId(request.rawBody));
  });

  it("records a delivery that names no shipment but does not process it", async () => {
    const { store, rows } = memoryStore();
    const res = await handleShiprocketWebhook({ rawBody: body({ current_status: "Delivered" }), headers: auth }, { config: cfg, store, schedule: () => assert.fail("must not schedule") });
    assert.equal(res.status, 200);
    assert.equal(rows[0].status, "IGNORED");
  });

  it("retries a processing crash with backoff and never stores a credential", async () => {
    const { store, rows } = memoryStore();
    await handleShiprocketWebhook({ rawBody: body(good), headers: auth }, { config: cfg, store, schedule: () => undefined });
    const outcome = await processShiprocketEvent("evt-1", { store, runner: { $transaction: async () => { throw new Error(`db down ${"q".repeat(60)}`); } } });
    assert.equal(outcome, "retry");
    assert.equal(rows[0].status, "FAILED");
    assert.ok(!rows[0].errorMessage!.includes("q".repeat(40)));
  });
});
