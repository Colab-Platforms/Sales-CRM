import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cachedDuplicateCheckoutIds } from "./abandoned.dashboard.canonical.js";

const fakeDb = () => {
  const calls = { n: 0 };
  return { calls, db: { $queryRaw: async () => { calls.n += 1; return []; } } as never };
};
const range = { start: new Date("2026-10-01T00:00:00Z") };

describe("cached duplicate ids for the Abandoned Leads list", () => {
  it("reads once within 60 seconds, again after, and never shares a result between database clients", async () => {
    const a = fakeDb();
    let t = 1_000_000;
    await cachedDuplicateCheckoutIds(a.db, range, () => t);
    await cachedDuplicateCheckoutIds(a.db, range, () => t + 59_000);
    assert.equal(a.calls.n, 1);
    await cachedDuplicateCheckoutIds(a.db, range, () => (t += 61_000));
    assert.equal(a.calls.n, 2);
    const b = fakeDb();
    await cachedDuplicateCheckoutIds(b.db, range, () => t);
    assert.equal(b.calls.n, 1, "another client has its own cache");
  });
  it("a different window start (exact, not rounded to the hour) is a different entry", async () => {
    const a = fakeDb();
    await cachedDuplicateCheckoutIds(a.db, range, () => 1);
    await cachedDuplicateCheckoutIds(a.db, { start: new Date("2026-10-15T00:00:00Z") }, () => 1);
    await cachedDuplicateCheckoutIds(a.db, { start: new Date(range.start.getTime() + 60_000) }, () => 1); // one minute later, same hour: still its own entry
    assert.equal(a.calls.n, 3);
  });
});
