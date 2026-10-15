import test from "node:test";
import assert from "node:assert/strict";
import { isSameCustomer, readAddress, type CustomerIdentity } from "./abandonment.customer-context.js";

const who = (over: Partial<CustomerIdentity> = {}): CustomerIdentity => ({ id: "a", firstName: "Asha", normalizedMobile: "+919811000001", normalizedEmail: null, ...over });

test("readAddress: the full checkout address, in reading order, with nothing invented", () => {
  const a = readAddress({ name: "Asha Rao", phone: "9811000001", line1: "12 MG Road", line2: "Flat 4B", landmark: "Near Station", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" })!;
  assert.equal(a.formatted, "12 MG Road, Flat 4B, Near Station, Pune, Maharashtra, 411001, India");
  assert.equal(a.name, "Asha Rao");
});

test("readAddress understands an order's stored shape too (address1 / address2 / province / zip)", () => {
  const a = readAddress({ name: "Ravi", address1: "7 Park Street", address2: "2nd floor", city: "Kolkata", province: "West Bengal", zip: "700016" })!;
  assert.equal(a.formatted, "7 Park Street, 2nd floor, Kolkata, West Bengal, 700016");
  assert.equal(a.state, "West Bengal");
  assert.equal(a.pincode, "700016");
});

test("readAddress: a partial address shows only the parts that exist; nothing usable is null (never a fabricated address)", () => {
  assert.equal(readAddress({ city: "Mumbai", state: "Maharashtra" })!.formatted, "Mumbai, Maharashtra");
  assert.equal(readAddress({ line1: "  ", city: null, pincode: "" }), null);
  assert.equal(readAddress(null), null);
  assert.equal(readAddress("Mumbai, Maharashtra"), null);
  assert.equal(readAddress([{ city: "x" }]), null);
});

test("readAddress: first/last name parts are joined when there is no full name", () => {
  assert.equal(readAddress({ firstName: "Asha", lastName: "Rao", city: "Pune" })!.name, "Asha Rao");
});

test("isSameCustomer: the same lead, or the same e-mail, is the same customer", () => {
  assert.equal(isSameCustomer(who(), who()), true);
  assert.equal(isSameCustomer(who({ normalizedEmail: "a@x.com", normalizedMobile: "+911" }), who({ id: "b", normalizedEmail: "a@x.com", normalizedMobile: "+912", firstName: "Someone Else" })), true);
});

test("isSameCustomer: a shared phone is the same person only if nothing contradicts it", () => {
  assert.equal(isSameCustomer(who(), who({ id: "b" })), true, "duplicate lead: same phone, same first name");
  assert.equal(isSameCustomer(who(), who({ id: "b", firstName: "  asha " })), true, "case and spacing do not matter");
  assert.equal(isSameCustomer(who(), who({ id: "b", firstName: "Meena" })), false, "a family member on the same phone is NOT the same customer");
  assert.equal(isSameCustomer(who({ normalizedEmail: "a@x.com" }), who({ id: "b", normalizedEmail: "b@x.com" })), false, "two different e-mails contradict the shared phone");
  assert.equal(isSameCustomer(who({ firstName: "Shiprocket Checkout lead" }), who({ id: "b", firstName: "Meena" })), true, "a name that was never captured cannot contradict");
});

test("isSameCustomer: different phone and no e-mail link is a different customer", () => {
  assert.equal(isSameCustomer(who(), who({ id: "b", normalizedMobile: "+919811000002" })), false);
  assert.equal(isSameCustomer(who({ normalizedMobile: null }), who({ id: "b", normalizedMobile: null })), false);
});
