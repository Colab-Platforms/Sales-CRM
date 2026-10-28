import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_POOL, nextPoolMember, simulateRoundRobin } from "./abandonment.pool.js";

const m = (...ids: string[]) => ids.map((id) => ({ id }));
describe("24/7 pool: round-robin rule", () => {
  it("the nine canonical telecallers, in order, by exact username", () => {
    assert.deepEqual(CANONICAL_POOL.map((p) => p.name), ["Shreya", "Aayush Tiwari", "Priti", "Aryan", "Yash", "Dheeraj", "Rustam", "Bhoomi", "Roshni"]);
    assert.equal(new Set(CANONICAL_POOL.map((p) => p.username)).size, 9);
    assert.ok(CANONICAL_POOL.every((p) => /^[a-z]+_awl$/.test(p.username)));
  });
  it("every member receives leads in order and wraps around", () => {
    const ids = CANONICAL_POOL.map((p) => p.username);
    const seq = simulateRoundRobin(m(...ids), null, 20).map((x) => x.id);
    assert.deepEqual(seq.slice(0, 9), ids);
    assert.deepEqual(seq.slice(9, 18), ids);
    assert.deepEqual(seq.slice(18), ids.slice(0, 2));
  });
  it("continues from the persisted cursor (a restart does not reset the sequence)", () => {
    assert.equal(nextPoolMember(m("a", "b", "c"), "b")?.id, "c");
    assert.equal(nextPoolMember(m("a", "b", "c"), "c")?.id, "a");
    assert.deepEqual(simulateRoundRobin(m("a", "b", "c"), "b", 3).map((x) => x.id), ["c", "a", "b"]);
  });
  it("a cursor on a member who is no longer eligible restarts from the first eligible one; nobody eligible = nobody", () => {
    assert.equal(nextPoolMember(m("a", "c"), "b")?.id, "a");
    assert.equal(nextPoolMember([], "a"), null);
    assert.deepEqual(simulateRoundRobin([], null, 5), []);
  });
});
