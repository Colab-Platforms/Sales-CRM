// Fastrr abandoned-cart recovery: config, API client (pagination, errors, retries), record mapping and the Excel address columns. NO real Fastrr call is made anywhere: every request goes to a
// mocked fetch, and the credentials used here are obvious fakes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { addressColumnsFromSnapshot } from "../../lib/addressColumns.js";
import { fetchAbandonedCarts, FastrrRecoveryError, readPaging, validateRange } from "./fastrr-recovery.client.js";
import { loadFastrrRecoveryConfig } from "./fastrr-recovery.config.js";
import { mapFastrrCart, parseCheckoutTime, readFastrrAddress } from "./fastrr-recovery.mapper.js";
import { FastrrRecoveryService, maskPhone } from "./fastrr-recovery.service.js";

const FAKE_TOKEN = "fake-x-auth-token-0001";
const FAKE_INFO = "fake-auth-info-0002";
const config = () => loadFastrrRecoveryConfig({ FASTRR_REPORTING_AUTH_TOKEN: FAKE_TOKEN, FASTRR_REPORTING_AUTH_INFO: FAKE_INFO });

const cart = (over: Record<string, unknown> = {}) => ({
  cart: "cart-1", custName: "Asha Rao", custPhone: "9876543210", custEmail: "asha@example.test", timeInitiated: "2026-11-14T01:30:00", amount: 549, subTotal: 599,
  checkoutStage: "ORDER_SCREEN", latestStage: "PAYMENT_INITIATED", orderId: null, shippingCharges: 0, codCharges: 0, couponDiscount: 50, notificationTime: null,
  items: [{ name: "Hair Oil", sku: "HO-1", quantity: 2, price: 299 }], ...over,
});

/** A mocked fetch serving the given responses in order; records every request. */
function mockFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const ok = (carts: unknown[], extra: Record<string, unknown> = {}) => () => new Response(JSON.stringify({ data: { abandonCarts: carts, ...extra } }), { status: 200 });
const status = (code: number, body = "{}", headers: Record<string, string> = {}) => () => new Response(body, { status: code, headers });
const noSleep = async () => undefined;

describe("config", () => {
  it("requires both credentials and reports only variable names", () => {
    assert.throws(() => loadFastrrRecoveryConfig({}), (e: Error) => /FASTRR_REPORTING_AUTH_TOKEN is not set/.test(e.message) && /FASTRR_REPORTING_AUTH_INFO is not set/.test(e.message));
  });
  it("keeps credentials out of serialisation and refuses another host or plain http", () => {
    const c = config();
    assert.ok(!JSON.stringify(c).includes(FAKE_TOKEN) && !JSON.stringify(c).includes(FAKE_INFO));
    assert.equal(c.baseUrl, "https://reporting.pickrr.com");
    const base = { FASTRR_REPORTING_AUTH_TOKEN: FAKE_TOKEN, FASTRR_REPORTING_AUTH_INFO: FAKE_INFO };
    assert.throws(() => loadFastrrRecoveryConfig({ ...base, FASTRR_REPORTING_BASE_URL: "https://evil.example.com" }), /pickrr\.com/);
    assert.throws(() => loadFastrrRecoveryConfig({ ...base, FASTRR_REPORTING_BASE_URL: "http://reporting.pickrr.com" }), /https/);
    assert.throws(() => loadFastrrRecoveryConfig({ ...base, FASTRR_REPORTING_AUTH_TOKEN: "bad\r\nx-evil: 1" }), (e: Error) => !e.message.includes("x-evil"));
  });
});

describe("range validation", () => {
  it("accepts real calendar ranges only", () => {
    assert.equal(validateRange("2026-11-13", "2026-11-14"), null);
    assert.match(validateRange("2026-11-14", "2026-11-13")!, /must not be after/);
    assert.match(validateRange("2026-02-30", "2026-03-01")!, /not valid/);
    assert.match(validateRange("14-11-2026", "2026-11-14")!, /YYYY-MM-DD/);
    assert.match(validateRange("2026-01-01", "2026-03-01")!, /at most/);
  });
});

describe("API client", () => {
  it("successful response: one GET with the documented path, query and both auth headers", async () => {
    const m = mockFetch([ok([cart()]), ok([])]);
    const r = await fetchAbandonedCarts(config(), "2026-11-14", "2026-11-14", { fetchImpl: m.fetchImpl, sleep: noSleep });
    assert.equal(r.records.length, 1);
    assert.equal(r.complete, true);
    assert.equal(r.stoppedBecause, "EMPTY_PAGE");
    const url = new URL(m.calls[0]!.url);
    assert.equal(url.origin + url.pathname, "https://reporting.pickrr.com/api/ve1/dashboard-service/report/abandon-carts");
    assert.deepEqual(Object.fromEntries(url.searchParams), { page: "0", from: "2026-11-14", to: "2026-11-14", source: "fastrr" });
    assert.equal(m.calls[0]!.headers["x-auth"], FAKE_TOKEN);
    assert.equal(m.calls[0]!.headers["authentication-info"], FAKE_INFO);
  });

  it("multiple pages are all read, with no assumed page size, until an empty page", async () => {
    const m = mockFetch([ok([cart({ cart: "a" }), cart({ cart: "b" })]), ok([cart({ cart: "c" })]), ok([cart({ cart: "d" }), cart({ cart: "e" }), cart({ cart: "f" })]), ok([])]);
    const r = await fetchAbandonedCarts(config(), "2026-11-14", "2026-11-14", { fetchImpl: m.fetchImpl, sleep: noSleep });
    assert.equal(r.records.length, 6);
    assert.equal(r.pages, 4);
    assert.deepEqual(m.calls.map((c) => new URL(c.url).searchParams.get("page")), ["0", "1", "2", "3"]);
  });

  it("empty response is a complete, empty result", async () => {
    const r = await fetchAbandonedCarts(config(), "2026-11-14", "2026-11-14", { fetchImpl: mockFetch([ok([])]).fetchImpl, sleep: noSleep });
    assert.deepEqual({ n: r.records.length, complete: r.complete }, { n: 0, complete: true });
  });

  it("honours a total / last-page flag when the response has one, without requiring it", async () => {
    const withTotal = mockFetch([ok([cart({ cart: "a" }), cart({ cart: "b" })], { totalCount: 2 })]);
    const r = await fetchAbandonedCarts(config(), "2026-11-14", "2026-11-14", { fetchImpl: withTotal.fetchImpl, sleep: noSleep });
    assert.equal(r.stoppedBecause, "TOTAL_REACHED");
    assert.equal(withTotal.calls.length, 1);
    assert.deepEqual(readPaging({ data: { pagination: { hasNext: false } } }), { total: null, last: true, totalPages: null });
  });

  it("an endpoint that ignores `page` and repeats the same carts stops instead of looping", async () => {
    const m = mockFetch([ok([cart({ cart: "a" }), cart({ cart: "b" })])]); // every page identical
    const r = await fetchAbandonedCarts(config(), "2026-11-14", "2026-11-14", { fetchImpl: m.fetchImpl, sleep: noSleep });
    assert.equal(r.records.length, 2);
    assert.equal(r.stoppedBecause, "REPEATED_PAGE");
    assert.equal(m.calls.length, 2);
  });

  it("hitting the page ceiling marks the result incomplete", async () => {
    let n = 0;
    const m = mockFetch([() => ok([cart({ cart: `c${n++}` })])()]);
    const r = await fetchAbandonedCarts(config(), "2026-11-14", "2026-11-14", { fetchImpl: m.fetchImpl, sleep: noSleep, maxPages: 3 });
    assert.deepEqual({ complete: r.complete, why: r.stoppedBecause, n: r.records.length }, { complete: false, why: "PAGE_LIMIT", n: 3 });
  });

  it("invalid responses are rejected and never retried", async () => {
    for (const bad of [status(200, "<html>nope</html>"), status(200, JSON.stringify({ data: {} })), status(200, JSON.stringify({ data: { abandonCarts: "x" } }))]) {
      const m = mockFetch([bad]);
      await assert.rejects(fetchAbandonedCarts(config(), "2026-11-14", "2026-11-14", { fetchImpl: m.fetchImpl, sleep: noSleep }), (e: unknown) => e instanceof FastrrRecoveryError && e.code === "MALFORMED");
      assert.equal(m.calls.length, 1);
    }
  });

  it("authentication failure is reported clearly, never retried, and never echoes credentials", async () => {
    for (const code of [401, 403]) {
      const m = mockFetch([status(code, JSON.stringify({ message: `bad token ${FAKE_TOKEN}` }))]);
      await assert.rejects(fetchAbandonedCarts(config(), "2026-11-14", "2026-11-14", { fetchImpl: m.fetchImpl, sleep: noSleep }), (e: unknown) => e instanceof FastrrRecoveryError && e.code === "AUTH" && !e.message.includes(FAKE_TOKEN));
      assert.equal(m.calls.length, 1);
    }
  });

  it("rate limits and server errors are retried with a bounded backoff, then succeed or give up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const recovered = mockFetch([status(429, "{}", { "retry-after": "2" }), status(503), ok([cart()]), ok([])]);
    const r = await fetchAbandonedCarts(config(), "2026-11-14", "2026-11-14", { fetchImpl: recovered.fetchImpl, sleep });
    assert.equal(r.records.length, 1);
    assert.equal(waits[0], 2000, "Retry-After is honoured");
    const dead = mockFetch([status(500)]);
    await assert.rejects(fetchAbandonedCarts(config(), "2026-11-14", "2026-11-14", { fetchImpl: dead.fetchImpl, sleep: noSleep }), (e: unknown) => e instanceof FastrrRecoveryError && e.code === "SERVER");
    assert.equal(dead.calls.length, 4, "bounded attempts");
  });

  it("a timeout is reported as a timeout", async () => {
    const hang = (async (_u: string, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    await assert.rejects(fetchAbandonedCarts(config(), "2026-11-14", "2026-11-14", { fetchImpl: hang, sleep: noSleep, timeoutMs: 10 }), (e: unknown) => e instanceof FastrrRecoveryError && e.code === "TIMEOUT");
  });
});

describe("record mapping", () => {
  it("maps a complete record: contact, items, value, time (IST), stage, order id and the original cart id", () => {
    const c = mapFastrrCart(cart());
    assert.equal(c.invalidReason, null);
    assert.equal(c.cartId, "cart-1");
    assert.equal(c.parsed!.externalId, "cart-1");
    assert.equal(c.parsed!.firstName, "Asha");
    assert.equal(c.parsed!.lastName, "Rao");
    assert.equal(c.parsed!.phone, "9876543210");
    assert.equal(c.parsed!.email, "asha@example.test");
    assert.equal(c.parsed!.cartValue, "549");
    assert.equal(c.parsed!.stage, "PAYMENT_INITIATED");
    assert.equal(c.parsed!.abandonedAt!.toISOString(), "2026-11-13T20:00:00.000Z", "a time without a zone is India Standard Time");
    assert.deepEqual(c.parsed!.items.map((i) => [i.name, i.sku, i.quantity]), [["Hair Oil", "HO-1", 2]]);
    assert.equal(c.itemsText, "Hair Oil x 2");
  });

  it("missing phone is fine when there is an email, and missing email is fine when there is a phone", () => {
    const onlyEmail = mapFastrrCart(cart({ custPhone: null }));
    assert.equal(onlyEmail.invalidReason, null);
    assert.equal(onlyEmail.parsed!.phone, null);
    const onlyPhone = mapFastrrCart(cart({ custEmail: "" }));
    assert.equal(onlyPhone.invalidReason, null);
    assert.equal(onlyPhone.parsed!.email, null);
    const junkPhone = mapFastrrCart(cart({ custPhone: "12", custEmail: "a@example.test" }));
    assert.equal(junkPhone.parsed!.phone, null, "an unusable phone is dropped, not passed on");
  });

  it("no usable contact, no cart id, unreadable time, or no valid products make the record invalid with a reason", () => {
    assert.match(mapFastrrCart(cart({ custPhone: null, custEmail: null })).invalidReason!, /No phone number or email/);
    assert.match(mapFastrrCart(cart({ custPhone: "12", custEmail: null })).invalidReason!, /not valid/);
    assert.match(mapFastrrCart(cart({ cart: "" })).invalidReason!, /Missing cart id/);
    assert.match(mapFastrrCart(cart({ timeInitiated: "yesterday-ish" })).invalidReason!, /checkout time/);
    assert.match(mapFastrrCart(cart({ items: [{ sku: "no-name" }, null, 5] })).invalidReason!, /no valid product/);
    assert.match(mapFastrrCart(cart({ items: "oops" })).invalidReason!, /no valid product/);
    assert.match(mapFastrrCart("not an object").invalidReason!, /not an object/);
    assert.equal(mapFastrrCart(cart({ custPhone: null, custEmail: null })).parsed, null);
  });

  it("invalid product lines are skipped but valid ones survive; bad quantities and prices become null", () => {
    const c = mapFastrrCart(cart({ items: [{ name: "Good", quantity: 1, price: "100" }, { name: "Odd", quantity: -3, price: "free" }, { title: "" }] }));
    assert.deepEqual(c.parsed!.items.map((i) => [i.name, i.quantity]), [["Good", 1], ["Odd", null]]);
  });

  it("amount falls back to subTotal and an unreadable amount leaves the value empty", () => {
    assert.equal(mapFastrrCart(cart({ amount: null })).parsed!.cartValue, "599");
    assert.equal(mapFastrrCart(cart({ amount: "abc", subTotal: undefined })).parsed!.cartValue, null);
    assert.equal(mapFastrrCart(cart({ amount: "₹1,299.50" })).parsed!.cartValue, "1299.5");
  });

  it("reads the checkout time as ISO, a space-separated stamp, or an epoch", () => {
    assert.equal(parseCheckoutTime("2026-11-14T01:30:00Z")!.toISOString(), "2026-11-14T01:30:00.000Z");
    assert.equal(parseCheckoutTime("2026-11-14 07:00:00")!.toISOString(), "2026-11-14T01:30:00.000Z");
    assert.equal(parseCheckoutTime(1_794_000_000)!.getTime(), 1_794_000_000_000);
    assert.equal(parseCheckoutTime("1794000000000")!.getTime(), 1_794_000_000_000);
    assert.equal(parseCheckoutTime(""), null);
    assert.equal(parseCheckoutTime("0"), null);
  });

  it("masks phones for display", () => {
    assert.equal(maskPhone("+919876543210"), "91******10");
    assert.equal(maskPhone(null), "");
  });
});

describe("address mapping (nothing is guessed)", () => {
  const full = { address1: "12 MG Road", address2: "Flat 4", landmark: "Near Metro", city: "Pune", state: "MH", pincode: "411001", country: "India" };
  it("an address object keeps every part and the complete text", () => {
    const c = mapFastrrCart(cart({ shippingAddress: full }));
    assert.deepEqual(c.address, { line1: "12 MG Road", line2: "Flat 4", landmark: "Near Metro", city: "Pune", state: "MH", pincode: "411001", country: "India", full: "12 MG Road, Flat 4, Near Metro, Pune, MH, 411001, India" });
    assert.equal(c.parsed!.shippingAddress!.city, "Pune");
  });
  it("a partial address leaves the missing cells empty", () => {
    const c = mapFastrrCart(cart({ shippingAddress: { address1: "12 MG Road", city: "Pune" } }));
    assert.deepEqual(c.address, { line1: "12 MG Road", line2: "", landmark: "", city: "Pune", state: "", pincode: "", country: "", full: "12 MG Road, Pune" });
  });
  it("a plain-text address is preserved whole and its parts are NOT guessed", () => {
    const c = mapFastrrCart(cart({ shippingAddress: "12 MG Road, Flat 4, Pune 411001" }));
    assert.equal(c.address.full, "12 MG Road, Flat 4, Pune 411001");
    assert.deepEqual([c.address.line1, c.address.city, c.address.pincode], ["", "", ""]);
    assert.equal(c.parsed!.shippingAddressText, "12 MG Road, Flat 4, Pune 411001");
  });
  it("a record with no address field has blank address cells", () => {
    const c = mapFastrrCart(cart());
    assert.deepEqual(Object.values(c.address), ["", "", "", "", "", "", "", ""]);
    assert.equal(c.parsed!.shippingAddress, null);
  });
  it("an explicit full-address field wins as the original text", () => {
    assert.equal(readFastrrAddress({ shippingAddress: { ...full, fullAddress: "Original, as typed" } }).text, "Original, as typed");
  });
});

describe("Excel address columns", () => {
  it("complete, partial and missing snapshots", () => {
    assert.deepEqual(addressColumnsFromSnapshot({ shippingAddress: { line1: "1 Rd", line2: "B", landmark: "L", city: "C", state: "S", pincode: "400001", country: "IN" } }), { line1: "1 Rd", line2: "B", landmark: "L", city: "C", state: "S", pincode: "400001", country: "IN", full: "1 Rd, B, L, C, S, 400001, IN" });
    assert.equal(addressColumnsFromSnapshot({ shippingAddress: { city: "Pune", pincode: "411001" } }).full, "Pune, 411001");
    assert.equal(addressColumnsFromSnapshot({ shippingAddress: { city: "Pune" }, shippingAddressText: "Original text" }).full, "Original text");
    for (const empty of [null, undefined, {}, { shippingAddress: null }, "x"]) assert.equal(addressColumnsFromSnapshot(empty).full, "");
  });
  it("the billing address is never used in place of the shipping address", () => {
    assert.equal(addressColumnsFromSnapshot({ billingAddress: { line1: "Billing St", city: "X" } }).line1, "");
  });
});

describe("recovery Excel export (mocked Fastrr, fake database)", () => {
  it("writes every record with customer, address, full-address and status columns", async () => {
    const records = [
      cart({ cart: "m1", shippingAddress: { address1: "12 MG Road", city: "Pune", pincode: "411001" } }),
      cart({ cart: "m2", custName: "No Address" }),
      cart({ cart: "dup" }), cart({ cart: "dup", timeInitiated: "2026-11-14T02:30:00" }),
      cart({ cart: "bad", custPhone: null, custEmail: null }),
      cart({ cart: "have" }),
    ];
    const fakeDb = {
      abandonment: { findMany: async () => [{ referenceId: "have" }] },
      $queryRaw: async () => [],
    };
    const service = new FastrrRecoveryService({ db: fakeDb as never, config, fetchOptions: { fetchImpl: mockFetch([ok(records), ok([])]).fetchImpl, sleep: noSleep } });
    const file = await service.exportWorkbook("2026-11-14", "2026-11-14");
    assert.equal(file.rows, 6);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as never);
    const sheet = wb.worksheets[0]!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    assert.deepEqual(header.slice(3, 14), ["Customer Name", "Phone Number", "Email", "Address Line 1", "Address Line 2", "Landmark", "City", "State", "Pincode", "Country", "Full Shipping Address"]);
    const rows = new Map<string, string[]>();
    sheet.eachRow((row, n) => { if (n > 1) rows.set(`${row.getCell(1).value}#${rows.size}`, (row.values as unknown[]).slice(1).map((v) => (v === null || v === undefined ? "" : String(v)))); });
    const byId = (id: string) => [...rows.entries()].filter(([k]) => k.startsWith(`${id}#`)).map(([, v]) => v);
    const m1 = byId("m1")[0]!;
    assert.deepEqual([m1[1], m1[6], m1[9], m1[11], m1[13]], ["Missing", "12 MG Road", "Pune", "411001", "12 MG Road, Pune, 411001"]);
    const m2 = byId("m2")[0]!;
    assert.deepEqual([m2[6], m2[9], m2[13]], ["", "", ""], "no address -> blank cells, nothing invented");
    assert.equal(byId("dup").length, 2);
    assert.deepEqual(byId("dup").map((r) => r[1]).sort(), ["Duplicate", "Missing"]);
    assert.equal(byId("bad")[0]![1], "Invalid");
    assert.equal(byId("have")[0]![1], "Already in CRM");
  });
});
