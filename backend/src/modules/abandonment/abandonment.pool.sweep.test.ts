import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sweepNewUnassigned } from "./abandonment.pool.service.js";

// The pool migration may not be applied yet (code deployed first). The five-minute sweep must then do nothing and must not touch the missing tables, so it neither throws nor logs a warning every tick.
describe("pool sweep before the migration is applied", () => {
  it("returns null and never queries the pool tables when they do not exist", async () => {
    let touched = false;
    const db = {
      $queryRaw: async () => [{ s: null, m: null }],
      abandonedPoolState: { findFirst: async () => { touched = true; throw new Error("relation does not exist"); } },
      lead: { findMany: async () => { touched = true; return []; } },
    };
    assert.equal(await sweepNewUnassigned(db as never), null);
    assert.equal(touched, false);
  });
  it("only one of the two tables existing is still treated as not migrated", async () => {
    const db = { $queryRaw: async () => [{ s: "abandoned_pool_state", m: null }], abandonedPoolState: { findFirst: async () => { throw new Error("must not be called"); } } };
    assert.equal(await sweepNewUnassigned(db as never), null);
  });
  it("tables present but the pool switched off: still nothing to do", async () => {
    const db = { $queryRaw: async () => [{ s: "abandoned_pool_state", m: "abandoned_pool_member" }], abandonedPoolState: { findFirst: async () => ({ enabled: false, enabledAt: null }) } };
    assert.equal(await sweepNewUnassigned(db as never), null);
  });
});
