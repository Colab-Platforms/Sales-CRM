// Database tests for the fill-only catalogue import. Run with: npm run test:db (ISOLATED database only). Every test runs in one transaction that is always rolled back.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { importCatalogRows } from "./products.catalog-import.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try { await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 60_000, maxWait: 30_000 }); } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
after(() => prisma.$disconnect());

async function* rows(list: { sku: string; weight: string; dims: string }[]) {
  for (const r of list) yield { masterskucode: r.sku, productname: r.sku, weight: r.weight, dimensions: r.dims };
}
const uid = () => randomUUID().slice(0, 8);

async function setup(tx: Prisma.TransactionClient) {
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, basePrice: "649.00" }, select: { id: true } });
  const mk = (data: Partial<Prisma.ProductVariantUncheckedCreateInput>) => tx.productVariant.create({ data: { productId: product.id, name: "V", price: "649.00", sku: `S-${uid()}`, ...data }, select: { id: true, sku: true } });
  return { empty: await mk({}), hasWeight: await mk({ weightKg: "0.5" }), hasDims: await mk({ lengthCm: "30", widthCm: "20", heightCm: "10" }), complete: await mk({ weightKg: "0.9", lengthCm: "40", widthCm: "30", heightCm: "20" }) };
}
const read = (tx: Prisma.TransactionClient, id: string) => tx.productVariant.findUniqueOrThrow({ where: { id }, select: { weightKg: true, lengthCm: true, widthCm: true, heightCm: true } });
const str = (r: Awaited<ReturnType<typeof read>>) => [r.weightKg, r.lengthCm, r.widthCm, r.heightCm].map((v) => (v === null ? null : v.toString()));

describe("fill-only catalogue import", () => {
  it("fills what is missing, never replaces what is recorded, and treats 0 as not recorded", async () => {
    await inRollback(async (tx) => {
      const v = await setup(tx);
      const catalog = [
        { sku: v.empty.sku!, weight: "0.12", dims: "20x15x2" },
        { sku: v.hasWeight.sku!, weight: "0.12", dims: "20x15x2" },
        { sku: v.hasDims.sku!, weight: "0.12", dims: "20x15x2" },
        { sku: v.complete.sku!, weight: "0.12", dims: "20x15x2" },
      ];
      await importCatalogRows(rows(catalog), { db: tx as never, fillMissingOnly: true });
      assert.deepEqual(str(await read(tx, v.empty.id)), ["0.12", "20", "15", "2"]);
      assert.deepEqual(str(await read(tx, v.hasWeight.id)), ["0.5", "20", "15", "2"], "weight kept, dimensions filled");
      assert.deepEqual(str(await read(tx, v.hasDims.id)), ["0.12", "30", "20", "10"], "dimensions kept, weight filled");
      assert.deepEqual(str(await read(tx, v.complete.id)), ["0.9", "40", "30", "20"], "a complete item is untouched");
    });
  });

  it("a catalogue row with a 0 weight fills only the dimensions; a row with 0x0x0 and 0 changes nothing", async () => {
    await inRollback(async (tx) => {
      const v = await setup(tx);
      await importCatalogRows(rows([{ sku: v.empty.sku!, weight: "0", dims: "20x15x2" }, { sku: v.hasWeight.sku!, weight: "0", dims: "0x0x0" }]), { db: tx as never, fillMissingOnly: true });
      assert.deepEqual(str(await read(tx, v.empty.id)), [null, "20", "15", "2"]);
      assert.deepEqual(str(await read(tx, v.hasWeight.id)), ["0.5", null, null, null]);
    });
  });

  it("a dry run plans the writes and makes none; running it for real twice changes nothing the second time", async () => {
    await inRollback(async (tx) => {
      const v = await setup(tx);
      const catalog = [{ sku: v.empty.sku!, weight: "0.12", dims: "20x15x2" }];
      const plan: { sku: string; kind: string; data: Record<string, number> }[] = [];
      await importCatalogRows(rows(catalog), { db: tx as never, fillMissingOnly: true, dryRun: true, plan: plan as never });
      assert.equal(plan.length, 1);
      assert.deepEqual(str(await read(tx, v.empty.id)), [null, null, null, null], "dry run wrote nothing");
      await importCatalogRows(rows(catalog), { db: tx as never, fillMissingOnly: true });
      const again = await importCatalogRows(rows(catalog), { db: tx as never, fillMissingOnly: true });
      assert.equal(again.unchanged, 1);
    });
  });

  it("the default (upload) behaviour is unchanged: it still replaces a recorded value that differs", async () => {
    await inRollback(async (tx) => {
      const v = await setup(tx);
      await importCatalogRows(rows([{ sku: v.complete.sku!, weight: "0.12", dims: "20x15x2" }]), { db: tx as never });
      assert.deepEqual(str(await read(tx, v.complete.id)), ["0.12", "20", "15", "2"]);
    });
  });
});
