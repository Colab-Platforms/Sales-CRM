import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCheckouts, type CheckoutRow } from "./abandoned.dashboard.canonical.js";

const T0 = Date.parse("2026-10-28T06:00:00Z");
const row = (id: string, minutes: number, over: Partial<CheckoutRow> = {}): CheckoutRow => ({ id, leadId: "lead-1", at: new Date(T0 + minutes * 60_000), open: true, key: '["Paan 60"]|499', ...over });
const summary = (rows: CheckoutRow[]) => classifyCheckouts(rows).map((c) => ({ canonical: c.canonical.id, dups: c.duplicates.map((d) => d.id), ambiguous: c.ambiguous }));

describe("canonical checkouts: anchored 60-minute window", () => {
  it("a re-entry within 60 minutes of the canonical row is a duplicate; the boundary is inclusive (60 min = duplicate, 61 = separate)", () => {
    assert.deepEqual(summary([row("a", 0), row("b", 60)]), [{ canonical: "a", dups: ["b"], ambiguous: false }]);
    assert.deepEqual(summary([row("a", 0), row("b", 61)]), [{ canonical: "a", dups: [], ambiguous: false }, { canonical: "b", dups: [], ambiguous: false }]);
  });

  it("THE CHAIN: carts each within 60 min of the previous but > 60 min from the first do NOT all collapse - the window is anchored on the canonical row, and the chain is flagged", () => {
    const r = summary([row("a", 0), row("b", 50), row("c", 100), row("d", 140)]);
    assert.deepEqual(r, [{ canonical: "a", dups: ["b"], ambiguous: false }, { canonical: "c", dups: ["d"], ambiguous: true }]);
  });

  it("deterministic: input order does not matter, and equal timestamps break by id", () => {
    const rows = [row("a", 0), row("b", 20), row("c", 50), row("d", 95), row("e", 95)];
    const forward = summary(rows);
    assert.deepEqual(summary([...rows].reverse()), forward);
    assert.deepEqual(summary([rows[3]!, rows[0]!, rows[4]!, rows[2]!, rows[1]!]), forward);
    assert.deepEqual(forward.find((g) => g.canonical === "d")?.dups, ["e"]);
  });

  it("different cart contents / values / customers never group; only the same lead + same cart does", () => {
    const rows = [row("a", 0), row("b", 5, { key: '["Paan 60"]|998' }), row("c", 6, { key: '["Gutka 60"]|499' }), row("d", 7, { leadId: "lead-2" }), row("e", 8)];
    assert.deepEqual(summary(rows), [{ canonical: "a", dups: ["e"], ambiguous: false }, { canonical: "b", dups: [], ambiguous: false }, { canonical: "c", dups: [], ambiguous: false }, { canonical: "d", dups: [], ambiguous: false }]);
  });

  it("a canonical row that is not open (recovered / closed) does not absorb later rows", () => {
    assert.deepEqual(summary([row("a", 0, { open: false }), row("b", 10)]), [{ canonical: "a", dups: [], ambiguous: false }, { canonical: "b", dups: [], ambiguous: false }]);
  });
});
