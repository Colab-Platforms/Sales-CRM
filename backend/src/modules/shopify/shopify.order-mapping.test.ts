import test from "node:test";
import assert from "node:assert/strict";
import { buildShopifyOrderPayload, orderSourceLabel, provinceCodeFor, splitName, type CrmOrderForShopify } from "./shopify.order-mapping.js";
import { customerNames, resolveShopifyCustomer } from "./shopify.order-customer.js";
import { compareShopifyOrder, createShopifyOrder, repairAndVerify, repairShopifyOrderFields, verifyShopifyOrder, type ShopifyOrderCreateInput } from "./shopify.orders.write.js";
import { syncAdvice } from "./shopify.sync-status.js";
import type { ShopifyClient } from "./shopify.client.js";

const crm = (over: Partial<CrmOrderForShopify> = {}): CrmOrderForShopify => ({
  orderNumber: "CRM-TEST-0001", currency: "INR", subtotal: "1298.00", discountAmount: "50.00", discountReason: "Custom discount", shippingAmount: "0.00", taxAmount: "0.00", totalAmount: "1248.00",
  shippingAddress: { name: "Anil Kumar Verma", line1: "Flat 7, Green Heights", line2: "Baner Road, Baner, Near Garden", houseNumber: "Flat 7", landmark: "Near Garden", deliveryInstructions: "Call before delivery", addressType: "HOME", city: "Pune", state: "Maharashtra", pincode: "411045", phone: "9811700001" },
  shippingPincode: "411045", metadata: { createdVia: "WHATSAPP_INBOX", createdBy: { id: "u1", name: "Aayush Tiwari", role: "SALESPERSON" } }, paymentMethod: "PAYMENT_LINK", paymentSucceeded: false, fromAiConversation: false,
  lead: { firstName: "Anil", lastName: null, leadNumber: "LEAD-ABC", email: "anil@example.com", normalizedMobile: "+919811700001", mobile: "9811700001" },
  items: [
    { quantity: 1, unitPrice: "649.00", productName: "Herbal Masala", variantName: "60 Pouches", sku: "HM-60", shopifyVariantId: "111", physical: true },
    { quantity: 1, unitPrice: "649.00", productName: "Herbal Tea", variantName: null, sku: "HT-1", shopifyVariantId: "222", physical: true },
  ],
  ...over,
});
const build = (o: CrmOrderForShopify = crm(), customer: ShopifyOrderCreateInput["customer"] | null = { toAssociate: { id: "gid://shopify/Customer/9" } }) => buildShopifyOrderPayload(o, { figuresMirror: true, customer });

test("customer: name, e-mail, phone and the verified association are in the payload", () => {
  const { input } = build();
  assert.deepEqual(input.customer, { toAssociate: { id: "gid://shopify/Customer/9" } });
  assert.equal(input.email, "anil@example.com");
  assert.equal(input.phone, "+919811700001");
});

test("shipping AND billing address use Shopify's real field names (provinceCode / countryCode - never province / country) and carry every address part", () => {
  const { input } = build();
  const a = input.shippingAddress as Record<string, unknown>;
  assert.deepEqual(a, { firstName: "Anil Kumar", lastName: "Verma", address1: "Flat 7, Green Heights", address2: "Baner Road, Baner, Near Garden", city: "Pune", provinceCode: "MH", zip: "411045", countryCode: "IN", phone: "9811700001" });
  assert.ok(!("province" in a) && !("country" in a), "the fields that do not exist in MailingAddressInput are not sent");
  assert.deepEqual(input.billingAddress, input.shippingAddress);
});

test("a state is sent as Shopify's own code (Odisha is OR, Telangana TS, Uttarakhand UK); an unknown state is not guessed and is reported", () => {
  assert.deepEqual(["Odisha", "Telangana", "Uttarakhand", "Karnataka", "KA"].map(provinceCodeFor), ["OR", "TS", "UK", "KA", "KA"]);
  const { input, report } = build(crm({ shippingAddress: { name: "A B", line1: "x", city: "Pune", state: "Atlantis", pincode: "411001" } }));
  assert.ok(!("provinceCode" in (input.shippingAddress as object)));
  assert.match(report.fields["shippingAddress.province"]!.reason!, /Atlantis/);
});

test("without a delivery name the lead's name is used; nothing populated is replaced by a blank", () => {
  const { input } = build(crm({ shippingAddress: { line1: "1 Road", city: "Pune", state: "Maharashtra", pincode: "411001" } }));
  // the lead has one name only: it goes in the LAST name field (the one Shopify requires) - nothing is dropped
  assert.equal(input.shippingAddress?.lastName, "Anil");
  assert.equal(input.shippingAddress?.phone, "+919811700001", "the lead's phone fills a missing address phone");
  assert.equal(input.shippingAddress?.zip, "411001");
});

test("every physical line item is shipping-required (Shopify's default is NOT); a service is not", () => {
  const { input } = build(crm({ items: [...crm().items, { quantity: 1, unitPrice: "100.00", productName: "Consultation", variantName: null, sku: null, shopifyVariantId: null, physical: false }] }));
  assert.deepEqual(input.lineItems.map((l) => l.requiresShipping), [true, true, false]);
  assert.deepEqual(input.lineItems.map((l) => l.variantId ?? l.title), ["111", "222", "Consultation"]);
});

test("discount, reason, shipping and PENDING payment: a pending payment link is never sent as paid", () => {
  const { input } = build(crm({ shippingAmount: "40.00", totalAmount: "1288.00" }));
  assert.deepEqual(input.discount, { amount: "50.00", description: "CRM discount (CRM-TEST-0001)" });
  assert.equal(input.shippingAmount, "40.00");
  assert.equal(input.financialStatus, "PENDING");
  assert.match(input.note!, /Discount 50\.00 \(Custom discount\); amount to collect is 1288\.00/);
  assert.match(input.note!, /Payment is pending/);
  assert.equal(build(crm({ paymentSucceeded: true })).input.financialStatus, "PAID");
  assert.equal(build(crm({ paymentSucceeded: true, settleAfterCreate: true })).input.financialStatus, "PENDING", "a prepaid order is created unpaid and marked paid by the verified-payment step");
});

test("when the CRM figures do not add up the discount/shipping lines are NOT mirrored, and the report says so", () => {
  const { input, report } = buildShopifyOrderPayload(crm(), { figuresMirror: false, customer: null });
  assert.equal(input.discount, undefined);
  assert.match(report.fields["discount/shipping"]!.reason!, /do not add up/);
});

test("note: creation context, creator, discount explanation, landmark and delivery instructions - and nothing sensitive", () => {
  const { input } = build();
  for (const part of ["Created in the CRM (CRM-TEST-0001)", "Created by Aayush Tiwari", "Landmark: Near Garden", "Delivery instructions: Call before delivery"]) assert.ok(input.note!.includes(part), part);
  assert.ok(!/token|secret|password|cashfree|payment link http/i.test(input.note!));
});

test("tags: CRM, the source, and the creator", () => {
  assert.deepEqual(build().input.tags, ["CRM", "CRM Source: WhatsApp Inbox", "Order Created by Aayush Tiwari"]);
});

test("the source is the real workflow, not always 'WhatsApp Inbox'", () => {
  assert.equal(orderSourceLabel({ metadata: { createdVia: "WHATSAPP_INBOX", abandonment: { id: "a" } }, fromAiConversation: false }).tag, "CRM Source: Abandoned Checkout");
  assert.equal(orderSourceLabel({ metadata: {}, fromAiConversation: true }).tag, "CRM Source: WhatsApp AI");
  assert.equal(orderSourceLabel({ metadata: {}, fromAiConversation: false }).tag, "CRM Source: Manual");
  assert.equal(build(crm({ metadata: { abandonment: { id: "a" }, createdBy: { id: "u", name: "Rustam" } } })).input.tags?.[1], "CRM Source: Abandoned Checkout");
});

test("metafields (crm namespace): order number, lead, source, creator, payment method, discount reason, landmark, instructions, address type", () => {
  const mf = Object.fromEntries((build().input.metafields ?? []).map((m) => [m.key, m.value]));
  assert.deepEqual(mf, { order_number: "CRM-TEST-0001", lead_number: "LEAD-ABC", order_source: "CRM Create Order (WhatsApp Inbox / lead page)", created_by: "Aayush Tiwari", payment_method: "PAYMENT_LINK", discount_reason: "Custom discount", landmark: "Near Garden", delivery_instructions: "Call before delivery", address_type: "HOME", house_number: "Flat 7" });
  assert.ok((build().input.metafields ?? []).every((m) => m.namespace === "crm"));
  assert.equal(build().input.sourceIdentifier, "CRM-TEST-0001", "the stable CRM reference that makes retries idempotent");
});

test("an order with no address, e-mail or phone still builds, and every omitted field is explained", () => {
  const { input, report } = buildShopifyOrderPayload(crm({ shippingAddress: null, lead: { ...crm().lead, email: null, normalizedMobile: null } }), { figuresMirror: true, customer: null, customerNote: "no match" });
  assert.equal(input.shippingAddress, undefined);
  for (const f of ["shippingAddress", "email", "phone", "customer"]) assert.equal(report.fields[f]!.outcome, "omitted", f);
});

// ---- customer identity --------------------------------------------------------------------------------------------------------------------------------
const cust = (id: string, phone: string | null, email: string | null = null) => ({ id: `gid://shopify/Customer/${id}`, externalId: id, name: null, email, phone, numberOfOrders: 1, amountSpent: null, address: null, createdAt: "", updatedAt: "" });
const customersClient = (items: unknown[] | Error) => ({ query: async () => { if (items instanceof Error) throw items; return { customers: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: items.map((c: any) => ({ id: c.id, firstName: null, lastName: null, email: c.email, phone: c.phone, numberOfOrders: "1", amountSpent: null, defaultAddress: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" })) } }; } }) as unknown as ShopifyClient;
const LEAD = { firstName: "Anil", lastName: null, email: "anil@example.com", normalizedMobile: "+919811700001" };

test("customer: one verified phone match is associated; no match creates one with the CRM name; a collision is not guessed; a failed lookup does not block the order", async () => {
  assert.deepEqual((await resolveShopifyCustomer(customersClient([cust("9", "+919811700001")]), LEAD, "Anil Kumar Verma")).customer, { toAssociate: { id: "gid://shopify/Customer/9" } });
  assert.deepEqual((await resolveShopifyCustomer(customersClient([]), LEAD, "Anil Kumar Verma")).customer, { toUpsert: { email: "anil@example.com", phone: "+919811700001", firstName: "Anil", lastName: "Kumar Verma" } });
  const phoneOther = await resolveShopifyCustomer(customersClient([cust("1", "+919811700001"), cust("2", null, "anil@example.com")]), LEAD, null);
  assert.equal(phoneOther.customer, null);
  assert.match(phoneOther.note, /2 different Shopify customers/);
  assert.equal((await resolveShopifyCustomer(customersClient([cust("3", "+919000000000")]), LEAD, null)).customer && "toAssociate" in ((await resolveShopifyCustomer(customersClient([cust("3", "+919000000000")]), LEAD, null)).customer as object), false, "a different phone is never associated");
  assert.equal((await resolveShopifyCustomer(customersClient(new Error("503")), LEAD, null)).customer, null);
});

test("customer names: the lead's own; a checkout placeholder or a first name only is completed from the delivery name", () => {
  assert.deepEqual(customerNames({ firstName: "Anil", lastName: "Verma" }, "Someone Else"), { firstName: "Anil", lastName: "Verma" });
  assert.deepEqual(customerNames({ firstName: "Shiprocket Checkout Lead", lastName: null }, "Nick Rao"), { firstName: "Nick", lastName: "Rao" });
  assert.deepEqual(customerNames({ firstName: "Anil", lastName: null }, "Anil Kumar Verma"), { firstName: "Anil", lastName: "Kumar Verma" });
  assert.deepEqual(splitName("Madonna"), { first: "Madonna", last: "" });
});

// ---- what is actually sent, and verification ------------------------------------------------------------------------------------------------------------
function recording(response: unknown) {
  const calls: { doc: string; vars: any }[] = [];
  const client = { query: async (doc: string, vars: any) => { calls.push({ doc, vars }); return typeof response === "function" ? (response as (d: string, v: any) => unknown)(doc, vars) : response; } } as unknown as ShopifyClient;
  return { client, calls };
}

test("createShopifyOrder puts customer, addresses, tags, metafields and requiresShipping into the request", async () => {
  const { client, calls } = recording({ orderCreate: { order: { id: "gid://shopify/Order/1", name: "#T1" }, userErrors: [] } });
  await createShopifyOrder(client, build().input);
  const o = calls[0]!.vars.order;
  assert.deepEqual(o.customer, { toAssociate: { id: "gid://shopify/Customer/9" } });
  assert.equal(o.shippingAddress.provinceCode, "MH");
  assert.equal(o.billingAddress.countryCode, "IN");
  assert.deepEqual(o.tags, ["CRM", "CRM Source: WhatsApp Inbox", "Order Created by Aayush Tiwari"]);
  assert.equal(o.metafields.length, 10);
  assert.ok(o.lineItems.every((l: any) => l.requiresShipping === true));
  assert.equal(o.financialStatus, "PENDING");
  assert.ok(!("transactions" in o), "no payment transaction is ever sent: unpaid stays unpaid");
});

const foundWithoutBilling = (over: Record<string, unknown> = {}) => ({ id: "x", note: "n", tags: ["CRM", "CRM Source: WhatsApp Inbox", "Order Created by Aayush Tiwari", "Existing"], displayFinancialStatus: "Pending", customer: { id: "c" }, shippingAddress: { address1: "a", city: "Pune", zip: "411045", provinceCode: "MH", countryCodeV2: "IN", firstName: "Anil" }, lineItems: { nodes: [{ requiresShipping: true }, { requiresShipping: true }] }, metafields: { nodes: build().input.metafields!.map((m) => ({ key: m.key })) }, ...over });

// What Shopify holds for a complete order: the billing address is saved as well (it equals the shipping address).
const found = (over: Record<string, unknown> = {}) => ({ billingAddress: { address1: "123 Main St", city: "Mumbai", zip: "400001" }, ...foundWithoutBilling(over) });

test("verification: a fully saved order is complete; each silently dropped part is named", () => {
  const input = build().input;
  assert.deepEqual(compareShopifyOrder(input, found() as never).missing, []);
  assert.deepEqual(compareShopifyOrder(input, found({ shippingAddress: null }) as never).missing, ["shippingAddress"]);
  assert.deepEqual(compareShopifyOrder(input, found({ lineItems: { nodes: [{ requiresShipping: false }] } }) as never).missing, ["lineItems.requiresShipping"]);
  assert.deepEqual(compareShopifyOrder(input, found({ tags: ["Existing"] }) as never).missing, ["tags"]);
  assert.deepEqual(compareShopifyOrder(input, found({ metafields: { nodes: [] } }) as never).missing, ["metafields"]);
  assert.deepEqual(compareShopifyOrder(input, found({ displayFinancialStatus: "Paid" }) as never).missing, ["financialStatus(unexpectedly paid)"], "an unpaid order that Shopify shows as paid is flagged");
});

test("a missing shipping address is re-sent with orderUpdate - only that field, never the note, tags or payment", async () => {
  const input = build().input;
  const { client, calls } = recording({ orderUpdate: { order: { id: "x" }, userErrors: [] } });
  const fix = await repairShopifyOrderFields(client, "gid://shopify/Order/1", input, ["shippingAddress"]);
  assert.deepEqual(fix.attempted, ["shippingAddress"]);
  assert.deepEqual(Object.keys(calls[0]!.vars.input).sort(), ["id", "shippingAddress"]);
  assert.equal((await repairShopifyOrderFields(client, "1", input, ["tags"])).attempted.length, 0, "tags are add-only elsewhere; nothing is overwritten here");
});

test("verifyShopifyOrder reads the order back and reports user errors from a repair", async () => {
  const input = build().input;
  const { client } = recording({ order: found() });
  assert.deepEqual((await verifyShopifyOrder(client, "1", input)).missing, []);
  const bad = recording({ orderUpdate: { order: null, userErrors: [{ message: "Address is invalid" }] } });
  assert.deepEqual((await repairShopifyOrderFields(bad.client, "1", input, ["shippingAddress"])).errors, ["Address is invalid"]);
});

test("verification: the billing address is verified too - a missing one is reported (orderUpdate cannot set it), a half-saved one is named", () => {
  const input = build().input;
  assert.deepEqual(compareShopifyOrder(input, found({ billingAddress: null }) as never).missing, ["billingAddress"]);
  assert.deepEqual(compareShopifyOrder(input, found({ billingAddress: { address1: null, city: "Mumbai", zip: "400001" } }) as never).missing, ["billingAddress.fields"]);
  assert.deepEqual(compareShopifyOrder({ ...input, billingAddress: undefined }, found({ billingAddress: null }) as never).missing, [], "nothing is demanded that was never sent");
  assert.equal(syncAdvice(["billingAddress"], []), "ADMIN", "it has to be fixed in Shopify");
  assert.equal(syncAdvice(["shippingAddress"], []), "RETRY");
});

test("repairAndVerify: a repair counts only when the read-back confirms it", async () => {
  const input = build().input;
  const ok = recording({ orderUpdate: { order: { id: "x" }, userErrors: [] }, order: found() });
  const fixed = await repairAndVerify(ok.client, "gid://shopify/Order/1", input, { missing: ["shippingAddress"], customerAssociated: true });
  assert.deepEqual([fixed.repaired, fixed.errors, fixed.check.missing], [["shippingAddress"], [], []]);
  // Shopify answers ok but the address is still not there: it was re-sent, yet it is NOT reported as repaired
  const silent = recording({ orderUpdate: { order: { id: "x" }, userErrors: [] }, order: found({ shippingAddress: null }) });
  const stuck = await repairAndVerify(silent.client, "1", input, { missing: ["shippingAddress"], customerAssociated: true });
  assert.deepEqual([stuck.repaired, stuck.check.missing], [[], ["shippingAddress"]]);
});

test("repairAndVerify: a refused repair is returned with Shopify's message, never swallowed, and nothing is claimed repaired", async () => {
  const input = build().input;
  const refused = recording({ orderUpdate: { order: null, userErrors: [{ message: "Address is invalid" }] }, order: found({ shippingAddress: null }) });
  const out = await repairAndVerify(refused.client, "1", input, { missing: ["shippingAddress"], customerAssociated: true });
  assert.deepEqual([out.repaired, out.errors, out.check.missing], [[], ["Address is invalid"], ["shippingAddress"]]);
  // a billing-only gap has nothing repairable: no Shopify call is made at all
  const none = recording({ order: found({ billingAddress: null }) });
  const skipped = await repairAndVerify(none.client, "1", input, { missing: ["billingAddress"], customerAssociated: true });
  assert.deepEqual([skipped.repaired, none.calls.length], [[], 0]);
  // and a complete order is left alone
  assert.deepEqual((await repairAndVerify(none.client, "1", input, { missing: [], customerAssociated: true })).repaired, []);
  assert.equal(none.calls.length, 0);
});

// ---- Shopify refuses an address whose LAST name is blank (it saves the order with NO address): the one-word name regression
test("a one-word recipient name is sent as the LAST name, with no first name - never dropped, never invented", () => {
  const { input, report } = build(crm({ shippingAddress: { name: "Radhe", line1: "Flat 4", city: "Pune", state: "Maharashtra", pincode: "411045" }, lead: { ...crm().lead, firstName: "Radhe", lastName: null } }));
  const a = JSON.parse(JSON.stringify(input.shippingAddress)) as Record<string, unknown>; // what goes over the wire
  assert.equal(a.lastName, "Radhe");
  assert.ok(!("firstName" in a), "no empty or invented first name");
  assert.deepEqual(input.billingAddress, input.shippingAddress, "billing carries the same name (the CRM keeps one address)");
  assert.match(report.fields["shippingAddress.firstName"]!.reason!, /one word.*last name/);
});

test("two and three word names, and a name taken from the lead, keep their first / last split", () => {
  const two = build(crm({ shippingAddress: { name: "Asha Rao", line1: "x", city: "Pune", state: "Maharashtra", pincode: "411045" } })).input.shippingAddress as Record<string, unknown>;
  assert.deepEqual([two.firstName, two.lastName], ["Asha", "Rao"]);
  const three = build(crm({ shippingAddress: { name: "Radhe Shyam Sharma", line1: "x", city: "Pune", state: "Maharashtra", pincode: "411045" } })).input.shippingAddress as Record<string, unknown>;
  assert.deepEqual([three.firstName, three.lastName], ["Radhe Shyam", "Sharma"]);
  const fromLead = build(crm({ shippingAddress: { line1: "x", city: "Pune", state: "Maharashtra", pincode: "411045" }, lead: { ...crm().lead, firstName: "Asha", lastName: "Rao" } })).input.shippingAddress as Record<string, unknown>;
  assert.deepEqual([fromLead.firstName, fromLead.lastName], ["Asha", "Rao"]);
});

test("a recipient with no name anywhere sends no name fields and says so in the mapping report (the read-back then refuses to call the sync complete)", () => {
  const { input, report } = build(crm({ shippingAddress: { line1: "x", city: "Pune", state: "Maharashtra", pincode: "411045" }, lead: { ...crm().lead, firstName: "", lastName: null } }));
  const a = JSON.parse(JSON.stringify(input.shippingAddress)) as Record<string, unknown>;
  assert.ok(!("firstName" in a) && !("lastName" in a));
  assert.match(report.fields["shippingAddress.name"]!.reason!, /requires a last name/);
});

test("the Indian address parts all survive the one-word-name case (state code, PIN, country, phone, both lines)", () => {
  const a = build(crm({ shippingAddress: { name: "Radhe", line1: "Flat 4, Green Park", line2: "Baner", city: "Pune", state: "Maharashtra", pincode: "411045", phone: "9811950001" } })).input.shippingAddress as Record<string, unknown>;
  assert.deepEqual([a.address1, a.address2, a.city, a.provinceCode, a.zip, a.countryCode, a.phone], ["Flat 4, Green Park", "Baner", "Pune", "MH", "411045", "IN", "9811950001"]);
});

test("mergeShippingForRepair keeps every non-blank value Shopify already has and fills only the blank ones", async () => {
  const { mergeShippingForRepair } = await import("./shopify.orders.write.js");
  const mapped = { firstName: "Asha", lastName: "Rao", address1: "CRM line 1", address2: "CRM line 2", city: "Pune", zip: "411045", provinceCode: "MH", countryCode: "IN", phone: "+919811950001" };
  const out = mergeShippingForRepair(mapped, { firstName: "Asha", lastName: "", address1: "Staff corrected", address2: null, city: " ", zip: "411046", provinceCode: "MH", countryCodeV2: "IN", phone: null });
  assert.deepEqual([out.address1, out.zip, out.city, out.lastName, out.address2, out.phone], ["Staff corrected", "411046", "Pune", "Rao", "CRM line 2", "+919811950001"]);
  assert.deepEqual(mergeShippingForRepair(mapped, null), mapped, "no existing address: the CRM address as is");
});
