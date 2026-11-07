// The Abandoned Checkouts total, the cards and the list use ONE canonical-checkout rule (isolated database, rolled-back transaction).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import AbandonedDashboardService from "./abandoned.dashboard.service.js";
import { duplicateCheckoutIds } from "./abandoned.dashboard.canonical.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try { await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 }); } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
after(() => prisma.$disconnect());
const uid = () => randomUUID().slice(0, 8);
const T0 = new Date("2020-03-10T06:00:00Z"); // 11:30 IST on 10 Mar 2020 (no real data this far back)
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

describe("canonical abandoned checkouts: total = list", () => {
  it("collapses a re-entry (same lead, items, value within 60 min) but keeps different values / products / far-apart carts, and the total equals the paginated list", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "A", username: `a-${uid()}`, role: Role.ADMIN } });
      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Asha", mobile: "9876500001" } });
      const other = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Bala", mobile: "9876500002" } });
      const mk = (leadId: string, at: Date, items: string[], value: number | null) =>
        tx.abandonment.create({ data: { leadId, type: "CHECKOUT", detectedAt: at, referenceId: `c-${uid()}`, cartSnapshot: { itemNames: items, itemCount: items.length, cartValue: value === null ? null : String(value), currency: "INR" } } });
      const first = await mk(lead.id, min(0), ["Paan 60"], 499); // canonical
      const reentry1 = await mk(lead.id, min(5), ["Paan 60"], 499); // duplicate (new cart id, 5 min later)
      const reentry2 = await mk(lead.id, min(50), ["Paan 60"], 499); // duplicate (within 60 of the previous row)
      await mk(lead.id, min(10), ["Paan 60"], 998); // different value -> separate
      await mk(lead.id, min(12), ["Gutka 60"], 499); // different product -> separate
      await mk(lead.id, min(300), ["Paan 60"], 499); // 4+ hours later -> separate checkout
      await mk(other.id, min(6), ["Paan 60"], 499); // another customer, same cart -> separate
      await mk(lead.id, min(20), [], 499); // no items -> never merged
      await mk(lead.id, min(21), ["Paan 60"], null); // no value -> never merged

      const range = { start: min(-30), end: min(600) };
      const dups = await duplicateCheckoutIds(tx as never, range);
      assert.deepEqual(new Set(dups), new Set([reentry1.id, reentry2.id]));
      assert.ok(!dups.includes(first.id));

      const svc = new AbandonedDashboardService(tx as never);
      const user = { id: admin.id, role: Role.ADMIN } as never;
      const f = { range: "custom", from: "2020-03-10", to: "2020-03-10", metric: "TOTAL" } as never;
      const p1: any = await svc.overview(user, f, 1, 3);
      const total = p1.summary.totalAbandoned;
      assert.equal(total, p1.details.pagination.totalItems);
      assert.equal(total, 9 - 2, "9 rows, 2 duplicates");
      const ids: string[] = [];
      for (let page = 1; page <= p1.details.pagination.totalPages; page++) ids.push(...((await svc.overview(user, f, page, 3)) as any).details.items.map((i: any) => i.id));
      assert.equal(ids.length, total);
      assert.equal(new Set(ids).size, total, "no row twice across pages");
      assert.ok(![reentry1.id, reentry2.id].some((d) => ids.includes(d)));
      assert.ok(ids.includes(first.id), "the canonical row (with its checkout id, assignment and history) is the one shown");
      const chart: any = await svc.chart(user, { range: "custom", from: "2020-03-10", to: "2020-03-10" } as never, "daily");
      assert.equal(chart.totals.abandoned, total, "the trend chart counts the same canonical checkouts as the headline total");
      const xlsx = await svc.exportXlsx(user, f);
      assert.equal(xlsx.rows, total, "the Excel export has the same rows as the list");
      const search: any = await svc.overview(user, { range: "custom", from: "2020-03-10", to: "2020-03-10", metric: "TOTAL", search: "Asha" } as never, 1, 50);
      assert.equal(search.details.items.length, 6, "a filter applies on top of the canonical rows (Asha's 8 rows - 2 duplicates)");
    });
  });
});
