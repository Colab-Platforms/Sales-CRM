import assert from "node:assert/strict";
import { test } from "node:test";
import { Role } from "../../../generated/prisma/enums.js";
import { buildCallRecordingWhere, parseCallRecordingFilters, productNames, scopedCallRecordingWhere } from "./call-recordings.service.js";

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

test("permission scope: a manager only sees leads assigned to them, always with a recording on a lead that has an abandoned checkout", () => {
  const where = scopedCallRecordingWhere({ id: "m1", role: Role.MANAGER, username: "m" }, {});
  const text = JSON.stringify(where);
  assert.match(text, /"assignedManagerId":"m1"/);
  assert.match(text, /"recording":\{"isNot":null\}/);
  assert.match(text, /"abandonments":\{"some":\{\}\}/);
});

test("product names come from the cart snapshot, falling back to the older name-only carts", () => {
  assert.deepEqual(productNames({ items: [{ name: "Paan Masala", quantity: 2 }, { name: "Paan Masala" }] }), ["Paan Masala"]);
  assert.deepEqual(productNames({ itemNames: ["Sleep Gummies"] }), ["Sleep Gummies"]);
  assert.deepEqual(productNames(null), []);
});
