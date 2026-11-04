// A date-range / "from" boundary must not change which rows are duplicates. A dense chain of re-entries (every 50 minutes) alternates canonical / duplicate under the anchored 60-minute rule, so a fixed look-back that
// cuts the chain mid-way would flip the rows after the cut and bring genuine duplicates back (or hide canonical ones). Isolated database, rolled-back transaction.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { duplicateCheckoutIds, cachedDuplicateCheckoutIds } from "./abandoned.dashboard.canonical.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try { await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 }); } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
after(() => prisma.$disconnect());

const T0 = new Date("2020-02-01T00:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe("canonical checkouts: range boundaries", () => {
  it("a chain that crosses the range start is classified exactly as if the whole history were loaded (the old 24-hour look-back flipped it), and a cached call for another start never reuses it", async () => {
    await inRollback(async (tx) => {
      const lead = await tx.lead.create({ data: { leadNumber: `L-${randomUUID().slice(0, 8)}`, firstName: "Chain" } });
      const ids: string[] = [];
      for (let i = 0; i < 34; i++) { // every 50 minutes for ~27 hours: even rows are canonical, odd rows are duplicates of the row before
        const a = await tx.abandonment.create({ data: { leadId: lead.id, type: "CHECKOUT", detectedAt: at(i * 50), referenceId: `r-${i}`, cartSnapshot: { itemNames: ["Paan"], itemCount: 1, cartValue: "499" } } });
        ids.push(a.id);
      }
      const end = at(34 * 50 + 60);
      const everything = new Set(await duplicateCheckoutIds(tx as never, { start: at(-1), end }));
      assert.deepEqual([...everything].sort(), ids.filter((_, i) => i % 2 === 1).sort(), "ground truth: the odd rows");

      // a range starting 24h30m in: 24 hours earlier falls on an ODD row, where a fixed look-back would start a wrong chain
      const start = at(24 * 60 + 30);
      const inRange = ids.filter((_, i) => at(i * 50).getTime() >= start.getTime());
      const got = (await duplicateCheckoutIds(tx as never, { start, end })).sort();
      assert.deepEqual(got, inRange.filter((id) => everything.has(id)).sort(), "same duplicates as the full-history classification, restricted to the range");

      // cache: a different start never reuses another start's list
      const a = await cachedDuplicateCheckoutIds(tx as never, { start });
      const b = await cachedDuplicateCheckoutIds(tx as never, { start: at(60) });
      assert.ok(b.length > a.length, "the earlier start covers more rows and is computed on its own");
    });
  });
});
