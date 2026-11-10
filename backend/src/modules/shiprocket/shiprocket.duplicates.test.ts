// Run with: npx tsx --test src/modules/shiprocket/shiprocket.duplicates.test.ts
// One CRM / Shopify order must never become two Shiprocket orders. No database, Shopify or Shiprocket: the in-memory order stand-in and a fake Shiprocket that remembers what it was sent and can
// already "hold" an order (e.g. the one the store's Shopify-Shiprocket channel imported under the Shopify name).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@/utils/apiError.js";
import type { ShiprocketOrderLookup } from "./shiprocket.client.js";
import { channelIdsFor, findLiveRemoteOrders, isRemoteCancelled, scanShiprocketDuplicates, type LiveShipmentRow } from "./shiprocket.duplicates.js";
import { syncOrderToShiprocket } from "./shiprocket.auto-sync.js";
import ShiprocketShipmentsService from "./shiprocket.shipments.service.js";
import { readShiprocketSync } from "./shiprocket.sync-record.js";
import { ADMIN, CONFIG, DIMS, ENV, ORDER, fakeDb, fakeShiprocket } from "./shiprocket.testutil.js";

const imported = (over: Partial<ShiprocketOrderLookup> = {}): ShiprocketOrderLookup => ({ shiprocketOrderId: "SR-IMPORT-9", channelOrderId: "AWL110598", status: "NEW", paymentMethod: "COD", totalCents: 54900, awb: null, courier: null, ...over });
const linked = { ...ORDER, externalId: "gid://shopify/Order/1", externalNumber: "AWL110598" };

function setup(opts: { existing?: ShiprocketOrderLookup[]; searchFails?: boolean; order?: typeof ORDER } = {}) {
  const db = fakeDb(opts.order ?? ORDER);
  const sr = fakeShiprocket({ existing: opts.existing, searchFails: opts.searchFails });
  const service = new ShiprocketShipmentsService(db.runner as never, { config: () => CONFIG, client: () => sr.api });
  const actor = { id: "creator-1", username: "creator", role: "SALESPERSON" as never };
  const auto = (trigger: "ORDER_CREATED" | "PAYMENT_VERIFIED" | "RETRY" = "ORDER_CREATED") => syncOrderToShiprocket({ db: db.tx as never, service, env: ENV }, ORDER.id, actor, trigger);
  return { db, sr, service, auto };
}

describe("pure helpers", () => {
  it("channel ids: the CRM order number and the Shopify name, trimmed, '#' removed, no duplicates, no blanks", () => {
    assert.deepEqual(channelIdsFor({ orderNumber: "CRM-1", externalNumber: "#AWL1" }), ["CRM-1", "AWL1"]);
    assert.deepEqual(channelIdsFor({ orderNumber: "CRM-1", externalNumber: null }, ["CRM-1", " "]), ["CRM-1"]);
  });

  it("a cancelled Shiprocket order does not count as existing", async () => {
    assert.equal(isRemoteCancelled("CANCELED"), true);
    assert.equal(isRemoteCancelled("Cancellation Requested"), true);
    assert.equal(isRemoteCancelled("NEW"), false);
    const lookup = async () => [imported({ status: "CANCELED" }), imported({ shiprocketOrderId: "SR-2", status: "NEW" })];
    assert.deepEqual((await findLiveRemoteOrders(lookup, ["AWL110598"])).map((o) => o.shiprocketOrderId), ["SR-2"]);
    assert.deepEqual(await findLiveRemoteOrders(lookup, ["AWL110598"], "SR-2"), [], "the order the CRM itself holds is not a twin");
  });
});

describe("one order, one Shiprocket order", () => {
  it("a repeated button click / webhook retry / retry action creates nothing new", async () => {
    const { sr, db, auto } = setup();
    assert.equal((await auto("ORDER_CREATED")).status, "SYNCED");
    for (const t of ["RETRY", "ORDER_CREATED", "PAYMENT_VERIFIED", "RETRY"] as const) assert.equal((await auto(t)).status, "SYNCED");
    assert.equal(sr.sent.length, 1);
    assert.equal(db.shipments.length, 1);
  });

  it("concurrent requests: exactly one reaches Shiprocket", async () => {
    // The real lock is a Postgres advisory lock; the stand-in has none, so serialise the way the lock does: the loser finds the winner's reservation.
    const { sr, db, auto } = setup();
    const results = [await auto("ORDER_CREATED")];
    results.push(...(await Promise.all([auto("RETRY"), auto("RETRY"), auto("PAYMENT_VERIFIED")])));
    assert.ok(results.every((r) => r.status === "SYNCED" || r.status === "PENDING"));
    assert.equal(sr.sent.length, 1);
    assert.equal(db.shipments.filter((s) => s.status !== "CANCELLED").length, 1);
  });

  it("the Shiprocket order id, shipment id and channel id are stored against the CRM order", async () => {
    const { db, auto } = setup();
    await auto();
    const s = db.shipments[0]!;
    assert.equal(s.providerOrderId, "SR-ORD-555");
    assert.equal(s.externalId, "SR-SHIP-777");
    assert.equal(s.channelOrderId, ORDER.orderNumber);
    const rec = readShiprocketSync(db.order.metadata)!;
    assert.equal(rec.shiprocketOrderId, "SR-ORD-555");
    assert.equal(rec.channelOrderId, ORDER.orderNumber);
  });

  it("Shiprocket already holds the order imported from the linked Shopify order: nothing is created, the reason names it, and the closed reservation does not look live", async () => {
    const { sr, db, auto } = setup({ order: linked, existing: [imported()] });
    const out = await auto();
    assert.equal(out.status, "FAILED");
    assert.match(out.reason ?? "", /Shiprocket already has an order for this sale: SR-IMPORT-9/);
    assert.equal(sr.sent.length, 0, "no second Shiprocket order");
    assert.ok(sr.searches.includes("AWL110598") && sr.searches.includes(ORDER.orderNumber));
    assert.equal(db.shipments.length, 1);
    assert.equal(db.shipments[0]!.status, "CANCELLED");
    assert.deepEqual((db.shipments[0]!.metadata as { shiprocket: { existingShiprocketOrderIds: string[]; duplicateBlocked: boolean } }).shiprocket.existingShiprocketOrderIds, ["SR-IMPORT-9"]);
    assert.equal(readShiprocketSync(db.order.metadata)?.status, "FAILED");
    // pressing retry again is refused the same way - still nothing is sent
    assert.equal((await auto("RETRY")).status, "FAILED");
    assert.equal(sr.sent.length, 0);
  });

  it("an order the CRM already sent (lost reply) is found by its CRM order number and not sent again", async () => {
    const { sr, auto } = setup({ existing: [imported({ shiprocketOrderId: "SR-OLD-1", channelOrderId: ORDER.orderNumber })] });
    assert.equal((await auto()).status, "FAILED");
    assert.equal(sr.sent.length, 0);
  });

  it("a cancelled Shiprocket order for the same Shopify name does not block a new submission", async () => {
    const { sr, auto } = setup({ order: linked, existing: [imported({ status: "CANCELED" })] });
    assert.equal((await auto()).status, "SYNCED");
    assert.equal(sr.sent.length, 1);
  });

  it("separate, legitimate orders from the same customer are never blocked (other order numbers, other Shopify names, same SKU)", async () => {
    // Shiprocket holds the customer's OTHER order (same SKU, same minute). This order has a different number and Shopify name, so it goes through.
    const other = imported({ shiprocketOrderId: "SR-OTHER", channelOrderId: "AWL100001", totalCents: 44900 });
    const { sr, auto } = setup({ order: linked, existing: [other, imported({ shiprocketOrderId: "SR-OTHER-2", channelOrderId: "CRM-SOMETHING-ELSE" })] });
    assert.equal((await auto()).status, "SYNCED");
    assert.equal(sr.sent.length, 1);
    assert.equal(sr.sent[0]!.order_items[0]!.sku, "AW-HM-PN-120");
  });

  it("a Shiprocket search that fails does not stop a first submission", async () => {
    const { sr, auto } = setup({ searchFails: true });
    assert.equal((await auto()).status, "SYNCED");
    assert.equal(sr.sent.length, 1);
  });

  it("but after an earlier attempt, a failing search blocks the retry (a lost reply may have left an order behind)", async () => {
    const { db, sr, service } = setup();
    // the first attempt ended without a reply: a closed reservation marked unconfirmed
    await db.tx.shipment.create({ data: { id: "old", orderId: ORDER.id, status: "CANCELLED", externalSource: "SHIPROCKET", externalId: "pending:old", metadata: { shiprocket: { creationFailed: true, creationUnconfirmed: false } } } as never });
    const flaky = fakeShiprocketFailing();
    const svc = new ShiprocketShipmentsService(db.runner as never, { config: () => CONFIG, client: () => flaky.api });
    await assert.rejects(() => svc.createShipment(ADMIN, ORDER.id, DIMS), (e: unknown) => e instanceof ApiError && e.statusCode === 409 && /could not be checked/.test(e.message));
    assert.equal(flaky.sent.length, 0);
    assert.equal(sr.sent.length, 0);
    void service;
  });

  it("manual 'Create shipment' goes through the same check", async () => {
    const { sr, db, service } = setup({ order: linked, existing: [imported()] });
    await assert.rejects(() => service.createShipment(ADMIN, ORDER.id, DIMS), (e: unknown) => e instanceof ApiError && e.statusCode === 409 && /already has an order/.test(e.message));
    assert.equal(sr.sent.length, 0);
    assert.equal(db.shipments.every((s) => s.status === "CANCELLED"), true);
  });
});

function fakeShiprocketFailing() {
  const f = fakeShiprocket({ searchFails: true });
  return f;
}

describe("report of duplicates that already exist (read-only)", () => {
  const row = (id: string, orderId: string, providerOrderId: string, externalNumber: string | null, status = "CREATED"): LiveShipmentRow => ({
    id,
    status,
    providerOrderId,
    externalId: `ship-${id}`,
    order: { id: orderId, orderNumber: `CRM-${orderId}`, externalNumber, lead: { firstName: "Rahul", lastName: null, mobile: "9999999999" } },
  });
  const db = (rows: LiveShipmentRow[]) => ({ shipment: { findMany: async () => rows } });

  it("lists a CRM order whose Shopify twin was imported by Shiprocket, and one with two live shipments; leaves clean and legitimate orders out", async () => {
    const remote: Record<string, ShiprocketOrderLookup[]> = {
      AWL110598: [imported({ shiprocketOrderId: "SR-IMPORT-9" }), imported({ shiprocketOrderId: "SR-CRM-1", channelOrderId: "AWL110598" })],
      AWL200000: [imported({ shiprocketOrderId: "SR-CRM-3", channelOrderId: "AWL200000" })],
    };
    const searches: string[] = [];
    const lookup = async (id: string) => { searches.push(id); return remote[id] ?? []; };
    const findings = await scanShiprocketDuplicates(
      db([
        row("a", "o1", "SR-CRM-1", "AWL110598"), // twin imported
        row("b", "o2", "SR-DUP-A", null), // two live rows for one order
        row("c", "o2", "SR-DUP-B", null),
        row("d", "o3", "SR-CRM-3", "AWL200000"), // the only remote order is the CRM's own: clean
        row("e", "o4", "SR-CRM-4", "AWL300000"), // nothing remote: clean
      ]),
      lookup,
    );
    assert.deepEqual(findings.map((f) => [f.kind, f.orderNumber]).sort(), [["MULTIPLE_LIVE_SHIPMENTS", "CRM-o2"], ["SHOPIFY_IMPORT_TWIN", "CRM-o1"]]);
    const twin = findings.find((f) => f.kind === "SHOPIFY_IMPORT_TWIN")!;
    assert.deepEqual(twin.otherShiprocketOrders.map((o) => o.shiprocketOrderId), ["SR-IMPORT-9"]);
    assert.deepEqual(twin.crmShiprocketOrderIds, ["SR-CRM-1"]);
    assert.equal(twin.customer, "Rahul");
    assert.ok(searches.every((s) => s.startsWith("AWL")), "only reads; searches the Shopify name");
  });
});
