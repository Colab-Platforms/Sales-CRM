import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearLiveHistoryCache, isGeneratedEmail, loadLiveShopifyOrders, verifiedCustomers, type LiveHistoryClient } from "./abandonment.shopify-history.js";
import { ShopifyConfigError } from "../shopify/shopify.config.js";
import type { NormalizedCustomerListItem } from "../shopify/shopify.customers.js";
import type { NormalizedOrderListItem } from "../shopify/shopify.orders.js";

beforeEach(() => clearLiveHistoryCache());

const LEAD = { normalizedMobile: "+919769686444", normalizedEmail: "9769686444@fastrr.com" };
const customer = (over: Partial<NormalizedCustomerListItem> = {}): NormalizedCustomerListItem => ({
  id: "gid://shopify/Customer/11", externalId: "11", name: "Raj Singh", email: null, phone: "+919769686444", numberOfOrders: 2, amountSpent: null, address: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", ...over,
});
const order = (id: string, over: Partial<NormalizedOrderListItem> = {}): NormalizedOrderListItem => ({
  id: `gid://shopify/Order/${id}`, externalId: id, name: `#${id}`, createdAt: `2026-0${(Number(id) % 9) + 1}-01T10:00:00Z`, processedAt: null, cancelledAt: null, financialStatus: "PAID", fulfillmentStatus: "FULFILLED", returnStatus: null,
  tags: [], paymentGateways: ["Razorpay"], customerName: null, customerEmail: null, customerPhone: null, currency: "INR", totalAmount: "1299.00", refundedAmount: null, shippingMethod: null,
  hasTracking: true, transactions: [], fulfillments: [{ id: "f1", status: "SUCCESS", displayStatus: "Delivered", createdAt: null, deliveredAt: null, trackingCompany: "Delhivery", trackingNumber: "AWB123", trackingUrl: "https://track.example/AWB123" }], itemCount: 1, ...over,
});
const toNode = (o: NormalizedOrderListItem) => ({ id: o.id, name: o.name, createdAt: o.createdAt, displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", paymentGatewayNames: [], totalPriceSet: { shopMoney: { amount: "10.00", currencyCode: "INR" } }, transactions: [], fulfillments: [], lineItems: { nodes: [] } });
function fake(customers: NormalizedCustomerListItem[], orders: Record<string, NormalizedOrderListItem[]>) {
  const searches: string[] = [];
  const client: LiveHistoryClient = {
    findCustomers: async (search) => { searches.push(search); return customers; },
    ordersOfCustomer: async (id) => ({ items: orders[id] ?? [], truncated: false }),
  };
  return { client, searches };
}

test("a generated checkout e-mail is not an identity; a real one is", () => {
  assert.equal(isGeneratedEmail("9769686444@fastrr.com", "+919769686444"), true);
  assert.equal(isGeneratedEmail("anyone@FASTRR.com"), true);
  assert.equal(isGeneratedEmail("9769686444@gmail.com", "+919769686444"), true, "the phone number as an e-mail name is a placeholder");
  assert.equal(isGeneratedEmail("raj@gmail.com", "+919769686444"), false);
  assert.equal(isGeneratedEmail(null), true);
});

test("a customer is matched on a verified phone, in any country-code format", () => {
  for (const phone of ["+919769686444", "9769686444", "919769686444", "09769686444"]) assert.equal(verifiedCustomers(LEAD, [customer({ phone })]).length, 1, phone);
});

test("a different phone, or only a similar name, never matches", () => {
  assert.equal(verifiedCustomers(LEAD, [customer({ phone: "+919769686445" })]).length, 0);
  assert.equal(verifiedCustomers(LEAD, [customer({ phone: null, name: "Raj Singh" })]).length, 0);
});

test("e-mail is a secondary signal: a real shared e-mail matches, unless the customer's phone is a different number; the generated one never does", () => {
  const real = { normalizedMobile: "+919769686444", normalizedEmail: "raj@gmail.com" };
  assert.equal(verifiedCustomers(real, [customer({ phone: null, email: "raj@gmail.com" })]).length, 1);
  assert.equal(verifiedCustomers(real, [customer({ phone: "+919000000000", email: "raj@gmail.com" })]).length, 0);
  assert.equal(verifiedCustomers(LEAD, [customer({ phone: null, email: "9769686444@fastrr.com" })]).length, 0);
});

test("loads the store's orders for a phone-matched customer, with payment, fulfilment and tracking; the generated e-mail is not searched", async () => {
  const { client, searches } = fake([customer()], { "11": [order("1042", { paymentGateways: ["Cash on Delivery (COD)"], financialStatus: "PENDING" }), order("1050")] });
  const out = await loadLiveShopifyOrders(() => client, LEAD, new Set());
  assert.equal(out.status, "OK");
  assert.equal(out.items.length, 2);
  assert.ok(!searches[0]!.includes("fastrr"), "the invented e-mail is not used to look the customer up");
  assert.match(searches[0]!, /phone:"\+919769686444"/);
  const cod = out.items.find((i) => i.orderNumber === "#1042")!;
  assert.equal(cod.paymentMode, "COD");
  assert.equal(cod.origin, "SHOPIFY");
  assert.equal(cod.inCrm, false);
  assert.match(cod.id, /^shopify:1042$/);
  assert.deepEqual(cod.tracking, { number: "AWB123", company: "Delhivery", url: "https://track.example/AWB123" });
  assert.equal(cod.fulfillmentLabel, "Delivered");
});

test("an order already in the CRM is not listed twice", async () => {
  const { client } = fake([customer()], { "11": [order("1042"), order("1050"), order("1042")] });
  const out = await loadLiveShopifyOrders(() => client, LEAD, new Set(["1042"]));
  assert.deepEqual(out.items.map((i) => i.orderNumber), ["#1050"]);
});

test("phone and e-mail naming DIFFERENT store customers is AMBIGUOUS: nothing is merged and nothing is guessed", async () => {
  const real = { normalizedMobile: "+919769686444", normalizedEmail: "raj@gmail.com" };
  const byPhone = customer({ externalId: "11", id: "gid://shopify/Customer/11" });
  const byEmail = customer({ externalId: "12", id: "gid://shopify/Customer/12", phone: null, email: "raj@gmail.com" });
  const { client } = fake([byPhone, byEmail], { "11": [order("1042")], "12": [order("1050")] });
  const out = await loadLiveShopifyOrders(() => client, real, new Set());
  assert.deepEqual([out.status, out.items.length, out.matchCount, out.customerFound], ["AMBIGUOUS", 0, 2, false]);
});

test("one store customer matched by BOTH phone and e-mail is a single, unambiguous match", async () => {
  const real = { normalizedMobile: "+919769686444", normalizedEmail: "raj@gmail.com" };
  const { client } = fake([customer({ email: "raj@gmail.com" })], { "11": [order("1042")] });
  const out = await loadLiveShopifyOrders(() => client, real, new Set());
  assert.deepEqual([out.status, out.items.length, out.customerFound], ["OK", 1, true]);
});

test("customer found with no orders is distinguishable from no customer at all", async () => {
  const found = await loadLiveShopifyOrders(() => fake([customer()], { "11": [] }).client, LEAD, new Set());
  clearLiveHistoryCache();
  const none = await loadLiveShopifyOrders(() => fake([], {}).client, LEAD, new Set());
  assert.deepEqual([found.status, found.customerFound, found.items.length], ["OK", true, 0]);
  assert.deepEqual([none.status, none.customerFound, none.items.length], ["OK", false, 0]);
});

test("pagination: every page of the customer's orders is read; hitting the cap is reported, not hidden", async () => {
  const pages = [Array.from({ length: 50 }, (_, i) => order(String(1000 + i))), Array.from({ length: 50 }, (_, i) => order(String(2000 + i))), [order("3000")]];
  const calls: (string | null)[] = [];
  // the REAL client wrapper over a fake page source
  const { shopifyHistoryClient } = await import("./abandonment.shopify-history.js");
  const fakeShopify = { query: async (_q: string, vars: { after?: string | null }) => {
    calls.push(vars.after ?? null);
    const idx = vars.after ? Number(vars.after) : 0;
    return { orders: { pageInfo: { hasNextPage: idx < pages.length - 1, hasPreviousPage: false, startCursor: null, endCursor: String(idx + 1) }, nodes: pages[idx]!.map(toNode) } };
  } };
  const out = await shopifyHistoryClient(fakeShopify as never).ordersOfCustomer("11");
  assert.equal(out.items.length, 101);
  assert.equal(out.truncated, false);
  assert.deepEqual(calls, [null, "1", "2"]);
});

test("a phone with no Shopify customer gives an empty, successful result (the page shows its empty state)", async () => {
  const out = await loadLiveShopifyOrders(() => fake([], {}).client, LEAD, new Set());
  assert.deepEqual([out.status, out.items.length], ["OK", 0]);
});

test("Shopify not configured / failing is reported, never thrown", async () => {
  const notConfigured = await loadLiveShopifyOrders(() => { throw new ShopifyConfigError("no config"); }, LEAD, new Set());
  assert.equal(notConfigured.status, "NOT_CONFIGURED");
  const broken: LiveHistoryClient = { findCustomers: async () => { throw new Error("socket hang up"); }, ordersOfCustomer: async () => ({ items: [], truncated: false }) };
  assert.equal((await loadLiveShopifyOrders(() => broken, LEAD, new Set())).status, "UNAVAILABLE");
});

test("a lead with no usable phone or real e-mail makes no Shopify call", async () => {
  let called = false;
  const client: LiveHistoryClient = { findCustomers: async () => { called = true; return []; }, ordersOfCustomer: async () => ({ items: [], truncated: false }) };
  const out = await loadLiveShopifyOrders(() => client, { normalizedMobile: null, normalizedEmail: "x@fastrr.com" }, new Set());
  assert.equal(called, false);
  assert.equal(out.items.length, 0);
});

test("a failure is never cached as an answer: the next look retries, and a failed lookup is never an empty 'OK'", async () => {
  let fail = true;
  const client: LiveHistoryClient = { findCustomers: async () => { if (fail) throw new Error("503"); return [customer()]; }, ordersOfCustomer: async () => ({ items: [order("1042")], truncated: false }) };
  const first = await loadLiveShopifyOrders(() => client, LEAD, new Set());
  assert.deepEqual([first.status, first.items.length], ["UNAVAILABLE", 0]);
  fail = false;
  const second = await loadLiveShopifyOrders(() => client, LEAD, new Set());
  assert.deepEqual([second.status, second.items.length], ["OK", 1]);
});

test("a failure while reading the customer's orders (not just the customer search) is also UNAVAILABLE", async () => {
  const client: LiveHistoryClient = { findCustomers: async () => [customer()], ordersOfCustomer: async () => { throw new Error("rate limited"); } };
  assert.equal((await loadLiveShopifyOrders(() => client, LEAD, new Set())).status, "UNAVAILABLE");
});
