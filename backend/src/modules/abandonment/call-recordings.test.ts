import assert from "node:assert/strict";
import { test } from "node:test";
import { CallRecordingsService, buildCallRecordingWhere, callRecordingOrder, leadProducts, parseCallRecordingFilters, productNames, scopedCallRecordingWhere } from "./call-recordings.service.js";

const TELECALLER = "11111111-1111-4111-8111-111111111111";
const CALL = "22222222-2222-4222-8222-222222222222";

test("a date range is required and must be in order", () => {
  assert.throws(() => parseCallRecordingFilters({}), /from and to/);
  assert.throws(() => parseCallRecordingFilters({ from: "2026-11-05", to: "2026-11-01" }), /from must not be after to/);
});

test("filters from a query string are validated and normalised", () => {
  const f = parseCallRecordingFilters({ from: "2026-11-01", to: "2026-11-05", telecallerIds: `${TELECALLER},${TELECALLER}`, statuses: "INTERESTED,CALL_BACK", outcomes: `status:NO_ANSWER`, minDuration: "30", sort: "oldest", customer: " Rahul " });
  assert.deepEqual(f.telecallerIds, [TELECALLER]);
  assert.deepEqual(f.statuses, ["INTERESTED", "CALL_BACK"]);
  assert.equal(f.minDuration, 30);
  assert.equal(f.sort, "oldest");
  assert.equal(f.customer, "Rahul");
  assert.throws(() => parseCallRecordingFilters({ from: "2026-11-01", to: "2026-11-05", telecallerIds: "nope" }), /telecaller/);
  assert.throws(() => parseCallRecordingFilters({ from: "2026-11-01", to: "2026-11-05", statuses: "BOGUS" }), /status/);
  assert.throws(() => parseCallRecordingFilters({ from: "2026-11-01", to: "2026-11-05", outcomes: "x:y" }), /outcome/);
  assert.throws(() => parseCallRecordingFilters({ from: "2026-11-01", to: "2026-11-05", minDuration: "90", maxDuration: "10" }), /minDuration/);
});

test("the date filter is the IST calendar day (00:00 IST to the next 00:00 IST)", () => {
  const where = buildCallRecordingWhere({ from: "2026-11-05", to: "2026-11-05" });
  const date = (where.AND as { OR: { startedAt?: { gte: Date; lt: Date } }[] }[])[0]!;
  const range = date.OR[0]!.startedAt!;
  assert.equal(range.gte.toISOString(), "2026-11-04T18:30:00.000Z");
  assert.equal(range.lt.toISOString(), "2026-11-05T18:30:00.000Z");
});

test("every filter is ANDed; the ticked recordings replace all of them", () => {
  const f = parseCallRecordingFilters({ from: "2026-11-01", to: "2026-11-05", telecallerIds: TELECALLER, mobile: "98765 43210", statuses: "INTERESTED" });
  assert.equal((buildCallRecordingWhere(f).AND as unknown[]).length, 4); // date, telecaller, mobile, status
  assert.equal((buildCallRecordingWhere(f, { ignoreDate: true }).AND as unknown[]).length, 3);
  const picked = parseCallRecordingFilters({ from: "2026-11-01", to: "2026-11-05", telecallerIds: TELECALLER, callIds: [CALL, CALL] });
  assert.deepEqual(buildCallRecordingWhere(picked), { AND: [{ id: { in: [CALL] } }] });
});

test("permission scope: always a recording on a lead inside the viewer's lead scope - abandoned or regular, no abandonment required", () => {
  const manager = JSON.stringify(scopedCallRecordingWhere({ assignedManagerId: "m1" }, {}));
  assert.match(manager, /"assignedManagerId":"m1"/);
  assert.match(manager, /"recording":\{"isNot":null\}/);
  assert.doesNotMatch(manager, /abandonments/);
  // admin: an empty scope restricts nothing but still needs a lead
  assert.deepEqual(scopedCallRecordingWhere({}, {}), { AND: [{}, { recording: { isNot: null } }, { leadId: { not: null } }] });
});

test("admins and managers alike hear every lead's recordings; nobody else may", async () => {
  const service = new CallRecordingsService({} as never);
  assert.deepEqual(await service.leadScopeFor({ id: "m1", role: "MANAGER", username: "m" }), {});
  assert.deepEqual(await service.leadScopeFor({ id: "a1", role: "ADMIN", username: "a" }), {});
  await assert.rejects(() => service.leadScopeFor({ id: "s1", role: "SALESPERSON", username: "s" }), /Only admins and managers/);
  await assert.rejects(() => service.leadScopeFor({ id: "h1", role: "HR", username: "h" }), /Only admins and managers/);
});

test("the lead type filter separates abandoned from regular leads; absent means both", () => {
  const base = { from: "2026-11-01", to: "2026-11-05" };
  const text = (f: object) => JSON.stringify(buildCallRecordingWhere(parseCallRecordingFilters({ ...base, ...f }), { ignoreDate: true }));
  assert.match(text({ leadType: "abandoned" }), /"abandonments":\{"some":\{\}\}/);
  assert.match(text({ leadType: "regular" }), /"abandonments":\{"none":\{\}\}/);
  assert.doesNotMatch(text({}), /abandonments/);
  assert.doesNotMatch(text({ leadType: "all" }), /abandonments/);
  assert.throws(() => parseCallRecordingFilters({ ...base, leadType: "bogus" }), /lead type/);
});

test("product names come from the cart snapshot, falling back to the older name-only carts", () => {
  assert.deepEqual(productNames({ items: [{ name: "Paan Masala", quantity: 2 }, { name: "Paan Masala" }] }), ["Paan Masala"]);
  assert.deepEqual(productNames({ itemNames: ["Sleep Gummies"] }), ["Sleep Gummies"]);
  assert.deepEqual(productNames(null), []);
});

test("the list is newest-first by default, on the call's own start time, and oldest-first only when asked", () => {
  const newest = [{ startedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }];
  assert.deepEqual(callRecordingOrder(undefined), newest);
  assert.deepEqual(callRecordingOrder("latest"), newest);
  assert.deepEqual(callRecordingOrder("oldest"), [{ startedAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }]);
  // no sort in the request = newest first
  assert.equal(parseCallRecordingFilters({ from: "2026-11-01", to: "2026-11-05" }).sort, undefined);
});

test("a lead's product: its cart when abandoned, else the interested product, else the product from its customer file", () => {
  const imported = { fields: { product: "Aayush Wellness Herbal Masala - Paan Masala" }, extra: { "All Products Bought": "x" } };
  assert.deepEqual(leadProducts({ itemNames: ["Sleep Gummies"] }, "Other", imported), ["Sleep Gummies"]);
  assert.deepEqual(leadProducts(null, "Interested Product", imported), ["Interested Product"]);
  assert.deepEqual(leadProducts(null, null, imported), ["Aayush Wellness Herbal Masala - Paan Masala"]);
  assert.deepEqual(leadProducts(null, " ", { fields: { product: "  " } }), []);
  assert.deepEqual(leadProducts(null, null, null), []);
});
