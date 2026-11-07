// Run with: ../backend/node_modules/.bin/tsx --test lib/assignment-plan.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countByPerson, roundRobinCounts, roundRobinPlan } from "./assignment-plan";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `lead-${i + 1}`);
const people = ["ajay", "bina", "chetan"];

describe("Round Robin plan", () => {
  it("100 leads over 3 salespeople is 34 / 33 / 33", () => {
    assert.deepEqual(roundRobinCounts(100, 3), [34, 33, 33]);
    assert.deepEqual(countByPerson(roundRobinPlan(ids(100), people), people).map((r) => r.count), [34, 33, 33]);
  });

  it("an equal split and uneven splits", () => {
    assert.deepEqual(roundRobinCounts(9, 3), [3, 3, 3]);
    assert.deepEqual(roundRobinCounts(10, 4), [3, 3, 2, 2]);
    assert.deepEqual(roundRobinCounts(2, 5), [1, 1, 0, 0, 0]);
    assert.deepEqual(roundRobinCounts(7, 1), [7]);
    assert.deepEqual(roundRobinCounts(0, 3), [0, 0, 0]);
    assert.deepEqual(roundRobinCounts(5, 0), []);
  });

  it("deals sequentially, starting with the first salesperson, every selected lead exactly once", () => {
    const plan = roundRobinPlan(ids(7), people);
    assert.deepEqual(plan.map((p) => `${p.abandonmentId}>${p.salespersonId}`), ["lead-1>ajay", "lead-2>bina", "lead-3>chetan", "lead-4>ajay", "lead-5>bina", "lead-6>chetan", "lead-7>ajay"]);
    assert.equal(new Set(plan.map((p) => p.abandonmentId)).size, 7);
  });

  it("nothing is planned without a salesperson or without leads", () => {
    assert.deepEqual(roundRobinPlan(ids(5), []), []);
    assert.deepEqual(roundRobinPlan([], people), []);
  });

  it("the counts always add up and never differ by more than one, for every size", () => {
    for (let n = 0; n <= 60; n++) {
      for (let k = 1; k <= 8; k++) {
        const counts = roundRobinCounts(n, k);
        assert.equal(counts.reduce((a, b) => a + b, 0), n);
        assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
        const planned = countByPerson(roundRobinPlan(ids(n), Array.from({ length: k }, (_, i) => `p${i}`)), Array.from({ length: k }, (_, i) => `p${i}`)).map((r) => r.count);
        assert.deepEqual(planned, counts, `n=${n} k=${k}: the server's dealing and the preview's counts agree`);
      }
    }
  });
});
