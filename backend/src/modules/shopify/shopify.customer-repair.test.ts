import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repairOrderCustomer, type RepairOutcome } from "./shopify.customer-repair.js";
import { materializeShopifyCustomer } from "./shopify.order-customer.js";

// The customer repair against a stateful fake Shopify and a stub database. Nothing leaves the process. The fake follows the call shapes the real code sends (audit read, customer search, customerCreate /
// customerUpdate / orderCustomerSet) and records every mutation so the tests can assert what was - and was not - changed.

interface FakeCustomer { id: string; phone: string; firstName: string | null; lastName: string | null }
interface World {
  order: { customerId: string | null; fulfillment: string; cancelled: boolean; total: string; shipping: string; financial: string };
  customers: FakeCustomer[];
  /** customerCreate refuses as a duplicate (and, if set, this customer then appears in the search) */
  createTaken?: boolean;
  appearsAfterTaken?: FakeCustomer[];
  linkFails?: boolean;
  nameNotKept?: boolean;
}
const PHONE = "+919811900001";

function fake(w: World) {
  const calls = { search: 0, create: [] as unknown[], update: [] as unknown[], link: [] as unknown[] };
  const customerNode = (c: FakeCustomer) => ({ id: c.id, firstName: c.firstName, lastName: c.lastName, email: null, phone: c.phone, numberOfOrders: "1", amountSpent: null, defaultAddress: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  const find = (id: string | null) => w.customers.find((c) => c.id === id) ?? null;
  const money = (a: string) => ({ shopMoney: { amount: a } });
  const client = {
    query: async (doc: string, vars: any) => {
      if (/crmAudit/.test(doc)) {
        const c = find(w.order.customerId);
        return { nodes: vars.ids.map((id: string) => ({
          id, name: "#AWL1", cancelledAt: w.order.cancelled ? "2026-10-20T00:00:00Z" : null, displayFinancialStatus: w.order.financial, displayFulfillmentStatus: w.order.fulfillment, currencyCode: "INR",
          totalPriceSet: money(w.order.total), currentTotalPriceSet: money(w.order.total), totalShippingPriceSet: money(w.order.shipping), totalDiscountsSet: money("0"), totalTaxSet: money("0"), totalRefundedSet: money("0"),
          customer: c ? { id: c.id, firstName: c.firstName, lastName: c.lastName, phone: c.phone } : null })) };
      }
      if (/customers\(/.test(doc) || /query.*customers/i.test(doc)) {
        calls.search += 1;
        const list = w.createTaken && calls.create.length > 0 && w.appearsAfterTaken ? w.appearsAfterTaken : w.customers;
        for (const c of list) if (!w.customers.includes(c)) w.customers.push(c);
        return { customers: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: list.map(customerNode) } };
      }
      if (/crmCustomerCreate/.test(doc)) {
        calls.create.push(vars.input);
        if (w.createTaken) return { customerCreate: { customer: null, userErrors: [{ field: ["phone"], message: "Phone has already been taken" }] } };
        const c = { id: `gid://shopify/Customer/${900 + calls.create.length}`, phone: vars.input.phone, firstName: vars.input.firstName ?? null, lastName: vars.input.lastName ?? null };
        w.customers.push(c);
        return { customerCreate: { customer: c, userErrors: [] } };
      }
      if (/crmCustomerUpdate/.test(doc)) {
        calls.update.push(vars.input);
        const c = find(vars.input.id)!;
        if (!w.nameNotKept) { c.firstName = vars.input.firstName ?? c.firstName; c.lastName = vars.input.lastName ?? c.lastName; }
        return { customerUpdate: { customer: c, userErrors: [] } };
      }
      if (/crmOrderCustomerSet/.test(doc)) {
        calls.link.push(vars);
        if (w.linkFails) return { orderCustomerSet: { order: null, userErrors: [{ field: null, message: "Order is archived" }] } };
        w.order.customerId = vars.customerId;
        return { orderCustomerSet: { order: { id: vars.orderId, customer: { id: vars.customerId } }, userErrors: [] } };
      }
      throw new Error(`unexpected Shopify call: ${doc.slice(0, 50)}`);
    },
  };
  return { client: client as never, calls };
}

interface RowOver { total?: string; shipping?: string; first?: string; last?: string | null; status?: string; pays?: string[]; shipments?: number }
function stubDb(over: RowOver = {}) {
  const row = () => ({
    id: "11111111-1111-1111-1111-111111111111", order_number: "CRM-1", external_id: "555", external_number: "#AWL1", status: over.status ?? "CONFIRMED", currency: "INR",
    total_amount: over.total ?? "699.00", shipping_amount: over.shipping ?? "50.00", discount_amount: "0.00", tax_amount: "0.00", mode: "COD", lead_id: "22222222-2222-2222-2222-222222222222",
    first_name: over.first ?? "Meera", last_name: over.last === undefined ? "Rao" : over.last, normalized_mobile: PHONE, email: null, pays: over.pays ?? ["PENDING"], shipments: BigInt(over.shipments ?? 0), refunds: BigInt(0), created_at: new Date("2026-10-23T04:00:00Z"),
  });
  return { $transaction: async (fn: any) => fn({ $executeRawUnsafe: async () => 0, $queryRaw: async () => [row()] }) } as never;
}
const clean = (): World["order"] => ({ customerId: null, fulfillment: "UNFULFILLED", cancelled: false, total: "699.00", shipping: "50.00", financial: "PENDING" });
const run = (w: World, plan: "LINK_OR_CREATE_CUSTOMER" | "FILL_CUSTOMER_NAME" | "NONE" | "MANUAL_REVIEW", apply: boolean, db = stubDb(), recorded: RepairOutcome[] = []) => {
  const f = fake(w);
  return repairOrderCustomer({ db, client: f.client, retryDelayMs: 0, record: async (_c, o) => { recorded.push(o); } }, "11111111-1111-1111-1111-111111111111", plan, { apply }).then((outcome) => ({ outcome, calls: f.calls, recorded }));
};
const named = (id: string, first: string | null, last: string | null = null): FakeCustomer => ({ id, phone: PHONE, firstName: first, lastName: last });

describe("customer repair", () => {
  it("DRY RUN changes nothing and says exactly what would change (create + link when no customer has the phone)", async () => {
    const w: World = { order: clean(), customers: [] };
    const { outcome, calls } = await run(w, "LINK_OR_CREATE_CUSTOMER", false);
    assert.equal(outcome.status, "dry_run");
    assert.match(outcome.changes.join(" "), /create a Shopify customer from the CRM name and phone, then link it/);
    assert.deepEqual([calls.create.length, calls.update.length, calls.link.length], [0, 0, 0]);
    assert.equal(w.order.customerId, null);
  });

  it("no customer for the phone: ONE customer is created with the CRM name and linked; the order is read back with it; the result is recorded", async () => {
    const w: World = { order: clean(), customers: [] };
    const { outcome, calls, recorded } = await run(w, "LINK_OR_CREATE_CUSTOMER", true);
    assert.equal(outcome.status, "repaired");
    assert.deepEqual(calls.create, [{ phone: PHONE, firstName: "Meera", lastName: "Rao" }]);
    assert.equal(calls.link.length, 1);
    assert.equal(w.order.customerId, "gid://shopify/Customer/901");
    assert.equal(recorded.length, 1);
    assert.equal(w.order.total, "699.00", "no amount was touched");
  });

  it("exactly one verified existing customer is REUSED (no create); a blank name is filled; a named one keeps its name", async () => {
    const blank: World = { order: clean(), customers: [named("gid://shopify/Customer/7", null)] };
    const a = await run(blank, "LINK_OR_CREATE_CUSTOMER", true);
    assert.equal(a.outcome.status, "repaired");
    assert.equal(a.calls.create.length, 0);
    assert.deepEqual(a.calls.update, [{ id: "gid://shopify/Customer/7", firstName: "Meera", lastName: "Rao" }]);
    const same: World = { order: clean(), customers: [named("gid://shopify/Customer/8", "Meera", "Rao")] };
    const b = await run(same, "LINK_OR_CREATE_CUSTOMER", true);
    assert.equal(b.outcome.status, "repaired");
    assert.equal(b.calls.update.length, 0, "an existing name is never overwritten");
    assert.equal(same.order.customerId, "gid://shopify/Customer/8");
  });

  it("a customer with this phone but a DIFFERENT name is not reused automatically (left for review)", async () => {
    const w: World = { order: clean(), customers: [named("gid://shopify/Customer/9", "Suresh", "Kumar")] };
    const { outcome, calls } = await run(w, "LINK_OR_CREATE_CUSTOMER", true);
    assert.equal(outcome.status, "skipped");
    assert.match(outcome.reason, /different name/);
    assert.deepEqual([calls.create.length, calls.update.length, calls.link.length], [0, 0, 0]);
  });

  it("two customers share the phone: nothing is created or linked", async () => {
    const w: World = { order: clean(), customers: [named("gid://shopify/Customer/1", "Meera"), named("gid://shopify/Customer/2", "Meera")] };
    const { outcome, calls } = await run(w, "LINK_OR_CREATE_CUSTOMER", true);
    assert.equal(outcome.status, "skipped");
    assert.match(outcome.reason, /2 different Shopify customers/);
    assert.deepEqual([calls.create.length, calls.link.length], [0, 0]);
  });

  it("RETRY / race: creation refused as a duplicate -> the customer is found by phone and reused; never a second create", async () => {
    const w: World = { order: clean(), customers: [], createTaken: true, appearsAfterTaken: [named("gid://shopify/Customer/55", null)] };
    const { outcome, calls } = await run(w, "LINK_OR_CREATE_CUSTOMER", true);
    assert.equal(outcome.status, "repaired");
    assert.equal(calls.create.length, 1);
    assert.equal(w.order.customerId, "gid://shopify/Customer/55");
    assert.equal(calls.update.length, 1, "its blank name was filled");
    const lost: World = { order: clean(), customers: [], createTaken: true, appearsAfterTaken: [] };
    const second = await run(lost, "LINK_OR_CREATE_CUSTOMER", true);
    assert.equal(second.outcome.status, "failed");
    assert.match(second.outcome.reason, /could not be found yet/);
    assert.equal(second.calls.create.length, 1);
    assert.equal(lost.order.customerId, null, "nothing linked, nothing duplicated");
  });

  it("running it again is harmless: once the customer is linked the order is clean and nothing is mutated", async () => {
    const w: World = { order: clean(), customers: [] };
    await run(w, "LINK_OR_CREATE_CUSTOMER", true);
    const again = await run(w, "LINK_OR_CREATE_CUSTOMER", true);
    assert.equal(again.outcome.status, "skipped");
    assert.match(again.outcome.reason, /state changed/);
    assert.deepEqual([again.calls.create.length, again.calls.update.length, again.calls.link.length], [0, 0, 0]);
  });

  it("state changed since the dry run -> skipped without touching anything: fulfilled, cancelled, a shipment, refund-free paid mismatch, a total that now differs", async () => {
    const cases: [string, World, ReturnType<typeof stubDb>][] = [
      ["fulfilled", { order: { ...clean(), fulfillment: "FULFILLED" }, customers: [] }, stubDb()],
      ["cancelled in Shopify", { order: { ...clean(), cancelled: true }, customers: [] }, stubDb()],
      ["cancelled in the CRM", { order: clean(), customers: [] }, stubDb({ status: "CANCELLED" })],
      ["shipment created", { order: clean(), customers: [] }, stubDb({ shipments: 1 })],
      ["paid in Shopify only", { order: { ...clean(), financial: "PAID" }, customers: [] }, stubDb()],
      ["total differs (the 699 vs 649 case)", { order: { ...clean(), total: "649.00", shipping: "0.00" }, customers: [] }, stubDb()],
    ];
    for (const [label, w, db] of cases) {
      const { outcome, calls } = await run(w, "LINK_OR_CREATE_CUSTOMER", true, db);
      assert.equal(outcome.status, "skipped", label);
      assert.deepEqual([calls.create.length, calls.update.length, calls.link.length], [0, 0, 0], label);
      assert.equal(w.order.customerId, null, label);
    }
  });

  it("an order with a money mismatch is NEVER repaired and its total/shipping stay exactly as they were", async () => {
    const w: World = { order: { ...clean(), total: "649.00", shipping: "0.00" }, customers: [] };
    const { outcome, calls } = await run(w, "MANUAL_REVIEW", true);
    assert.equal(outcome.status, "skipped");
    assert.deepEqual([calls.create.length, calls.update.length, calls.link.length], [0, 0, 0]);
    assert.deepEqual([w.order.total, w.order.shipping], ["649.00", "0.00"]);
  });

  it("FILL_CUSTOMER_NAME sets only the blank name; it is verified by reading back, and a name Shopify did not keep is reported as failed", async () => {
    const ok: World = { order: { ...clean(), customerId: "gid://shopify/Customer/3" }, customers: [named("gid://shopify/Customer/3", null)] };
    const a = await run(ok, "FILL_CUSTOMER_NAME", true);
    assert.equal(a.outcome.status, "repaired");
    assert.deepEqual(a.calls.update, [{ id: "gid://shopify/Customer/3", firstName: "Meera", lastName: "Rao" }]);
    assert.equal(a.calls.link.length, 0);
    const lost: World = { order: { ...clean(), customerId: "gid://shopify/Customer/4" }, customers: [named("gid://shopify/Customer/4", null)], nameNotKept: true };
    const b = await run(lost, "FILL_CUSTOMER_NAME", true);
    assert.equal(b.outcome.status, "failed");
    assert.match(b.outcome.reason, /still has no name/);
  });

  it("a Shopify refusal to link is a recorded FAILURE (not success), and a retry is safe", async () => {
    const w: World = { order: clean(), customers: [named("gid://shopify/Customer/5", "Meera", "Rao")], linkFails: true };
    const { outcome, recorded } = await run(w, "LINK_OR_CREATE_CUSTOMER", true);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason, /Order is archived/);
    assert.equal(recorded.length, 1);
    assert.equal(w.order.customerId, null);
    w.linkFails = false;
    assert.equal((await run(w, "LINK_OR_CREATE_CUSTOMER", true)).outcome.status, "repaired");
  });
});

describe("new orders: a phone-only lead's customer is created or reused with the CRM name (idempotent retries)", () => {
  const create = { ensure: { create: { phone: PHONE, email: null, firstName: "Meera", lastName: "Rao" } }, customer: null, note: "n" };
  it("creates once and associates; a second push attempt after the customer exists reuses it (no duplicate)", async () => {
    const w: World = { order: clean(), customers: [] };
    const f = fake(w);
    const first = await materializeShopifyCustomer(f.client, create);
    assert.deepEqual(first.customer, { toAssociate: { id: "gid://shopify/Customer/901" } });
    // retry of the same push: the decision step now finds the customer by phone, so it asks for nothing to be created
    const retry = await materializeShopifyCustomer(f.client, { customer: { toAssociate: { id: "gid://shopify/Customer/901" } }, note: "associated" });
    assert.deepEqual(retry.customer, { toAssociate: { id: "gid://shopify/Customer/901" } });
    assert.equal(f.calls.create.length, 1);
  });
});
