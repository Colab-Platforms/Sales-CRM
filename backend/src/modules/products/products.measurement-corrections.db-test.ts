// Database tests for the targeted measurement-corrections import. Run with: npm run test:db (ISOLATED database only). Every test runs in one transaction that is always rolled back.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { prisma } from "../../lib/prisma.js";
import { ProductType } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { applyCorrections, formatPlan, planCorrections, readCorrectionCsv } from "./products.measurement-corrections.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 60_000, maxWait: 30_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}
after(() => prisma.$disconnect());

type R = Record<string, string>;
const blank = { masterskucode: "", productname: "", updatetype: "FILL", proposedweightkg: "", proposedlengthcm: "", proposedbreadthcm: "", proposedheightcm: "" };
async function* src(records: R[]) {
  let line = 2;
  for (const r of records) yield { record: { ...blank, ...r }, line: line++ };
}
const uid = () => randomUUID().slice(0, 8);

async function setup(tx: Prisma.TransactionClient) {
  const p = await tx.product.create({ data: { name: "Catalogue", type: ProductType.PRODUCT, basePrice: "100.00" }, select: { id: true } });
  const mk = (sku: string | null, name: string, data: Partial<Prisma.ProductVariantUncheckedCreateInput> = {}) =>
    tx.productVariant.create({ data: { productId: p.id, name, price: "100.00", ...(sku ? { sku } : {}), ...data }, select: { id: true } });
  const sku = { empty: `E-${uid()}`, partial: `P-${uid()}`, complete: `C-${uid()}`, unlisted: `U-${uid()}`, bundle: `B-${uid()}` };
  const v = {
    empty: await mk(sku.empty, "Empty"),
    partial: await mk(sku.partial, "Partial", { weightKg: "0.5" }),
    complete: await mk(sku.complete, "Complete", { weightKg: "0.9", lengthCm: "40", widthCm: "30", heightCm: "20" }),
    unlisted: await mk(sku.unlisted, "Unlisted"),
    bundle: await mk(sku.bundle, "Immunity & Vitality Bundle"),
    noSku: await mk(null, "Mind & Lifestyle Balance Bundle"),
  };
  const standalone = await tx.product.create({ data: { name: "Standalone", type: ProductType.PRODUCT, basePrice: "10.00", sku: `S-${uid()}` }, select: { id: true, sku: true } });
  return { sku, v, standalone };
}
const read = async (tx: Prisma.TransactionClient, id: string) => {
  const r = await tx.productVariant.findUniqueOrThrow({ where: { id }, select: { weightKg: true, lengthCm: true, widthCm: true, heightCm: true } });
  return [r.weightKg, r.lengthCm, r.widthCm, r.heightCm].map((x) => (x === null ? null : x.toString()));
};

describe("targeted measurement corrections", () => {
  it("dry run: shows exactly which SKU and fields change, and writes nothing", async () => {
    await inRollback(async (tx) => {
      const { sku, v } = await setup(tx);
      const plan = await planCorrections(src([{ masterskucode: sku.empty, proposedweightkg: "0.25", proposedlengthcm: "10", proposedbreadthcm: "8", proposedheightcm: "5" }]), tx as never);
      assert.equal(plan.errors.length, 0);
      assert.deepEqual(plan.items[0]!.changes.map((c) => [c.field, c.from, c.to, c.kind]), [["weightKg", null, 0.25, "FILL"], ["lengthCm", null, 10, "FILL"], ["widthCm", null, 8, "FILL"], ["heightCm", null, 5, "FILL"]]);
      const text = formatPlan(plan, false).join("\n");
      assert.ok(text.includes(`WILL CHANGE  ${sku.empty}`));
      assert.ok(text.includes("weight (kg): (none) -> 0.25   [FILL]"));
      assert.deepEqual(await read(tx, v.empty.id), [null, null, null, null], "nothing was written by planning");
    });
  });

  it("fills missing values, leaves blank cells and unlisted SKUs unchanged", async () => {
    await inRollback(async (tx) => {
      const { sku, v } = await setup(tx);
      const plan = await planCorrections(
        src([
          { masterskucode: sku.empty, proposedweightkg: "0.25", proposedlengthcm: "10", proposedbreadthcm: "8", proposedheightcm: "5" },
          { masterskucode: sku.partial, proposedlengthcm: "12" }, // weight 0.5 is recorded and not mentioned; breadth / height blank
        ]),
        tx as never,
      );
      assert.equal(await applyCorrections(plan, tx as never), 2);
      assert.deepEqual(await read(tx, v.empty.id), ["0.25", "10", "8", "5"]);
      assert.deepEqual(await read(tx, v.partial.id), ["0.5", "12", null, null], "only the one supplied field changed");
      assert.deepEqual(await read(tx, v.unlisted.id), [null, null, null, null]);
      assert.deepEqual(await read(tx, v.complete.id), ["0.9", "40", "30", "20"]);
    });
  });

  it("an approved replacement (REPLACE) works for the supplied field only; a FILL row never replaces a recorded value", async () => {
    await inRollback(async (tx) => {
      const { sku, v } = await setup(tx);
      const conflict = await planCorrections(src([{ masterskucode: sku.complete, proposedweightkg: "0.8", updatetype: "FILL" }]), tx as never);
      assert.equal(conflict.items.length, 0);
      assert.ok(/already 0\.9.*mark it REPLACE/.test(conflict.errors[0]!.message));
      await assert.rejects(applyCorrections(conflict, tx as never), /Refusing to apply/);
      assert.deepEqual(await read(tx, v.complete.id), ["0.9", "40", "30", "20"]);

      const ok = await planCorrections(src([{ masterskucode: sku.complete, proposedweightkg: "0.8", updatetype: "REPLACE" }]), tx as never);
      assert.deepEqual(ok.items[0]!.changes.map((c) => [c.field, c.from, c.to, c.kind]), [["weightKg", "0.9", 0.8, "REPLACE"]]);
      assert.ok(formatPlan(ok, false).join("\n").includes("weight (kg): 0.9 -> 0.8   [REPLACE]"));
      await applyCorrections(ok, tx as never);
      assert.deepEqual(await read(tx, v.complete.id), ["0.8", "40", "30", "20"], "dimensions untouched");
    });
  });

  it("errors block everything (all or nothing): unknown SKU, duplicate SKU, invalid values; the valid row in the same file is NOT written", async () => {
    await inRollback(async (tx) => {
      const { sku, v } = await setup(tx);
      const plan = await planCorrections(
        src([
          { masterskucode: sku.empty, proposedweightkg: "0.25" },
          { masterskucode: `NOPE-${uid()}`, proposedweightkg: "0.25" },
          { masterskucode: sku.partial, proposedweightkg: "0" },
          { masterskucode: sku.partial, proposedweightkg: "-1" },
          { masterskucode: sku.unlisted, proposedlengthcm: "abc" },
          { masterskucode: sku.empty, proposedweightkg: "0.3" },
        ]),
        tx as never,
      );
      assert.equal(plan.items.length, 1, "the one valid row is planned");
      const msgs = plan.errors.map((e) => e.message).join("|");
      assert.ok(msgs.includes("unknown SKU"));
      assert.ok(msgs.includes("must be greater than 0"));
      assert.ok(msgs.includes("not a positive number"));
      assert.ok(msgs.includes("duplicate SKU"));
      await assert.rejects(applyCorrections(plan, tx as never), /Refusing to apply/);
      assert.deepEqual(await read(tx, v.empty.id), [null, null, null, null], "not even the valid row was written");
    });
  });

  it("bundles: matched only by a valid unique SKU - never by name", async () => {
    await inRollback(async (tx) => {
      const { sku, v } = await setup(tx);
      const bySku = await planCorrections(src([{ masterskucode: sku.bundle, productname: "anything", proposedweightkg: "0.6", proposedlengthcm: "20", proposedbreadthcm: "15", proposedheightcm: "6" }]), tx as never);
      assert.equal(bySku.errors.length, 0);
      await applyCorrections(bySku, tx as never);
      assert.deepEqual(await read(tx, v.bundle.id), ["0.6", "20", "15", "6"]);
      // by name only (the bundle that has no SKU): rejected, and nothing about it changes
      const byName = await planCorrections(src([{ masterskucode: "", productname: "Mind & Lifestyle Balance Bundle", proposedweightkg: "0.6" }]), tx as never);
      assert.equal(byName.items.length, 0);
      assert.ok(/no SKU.*never by name/.test(byName.errors[0]!.message));
      assert.deepEqual(await read(tx, v.noSku.id), [null, null, null, null]);
      // a "SKU" that is just another record's NAME does not match it either
      const nameAsSku = await planCorrections(src([{ masterskucode: "Mind & Lifestyle Balance Bundle", proposedweightkg: "0.6" }]), tx as never);
      assert.ok(nameAsSku.errors[0]!.message.includes("unknown SKU"));
      assert.deepEqual(await read(tx, v.noSku.id), [null, null, null, null]);
    });
  });

  it("a product sold without variants is matched by its own SKU", async () => {
    await inRollback(async (tx) => {
      const { standalone } = await setup(tx);
      const plan = await planCorrections(src([{ masterskucode: standalone.sku!, proposedweightkg: "1.2" }]), tx as never);
      assert.equal(plan.items[0]!.target, "product");
      await applyCorrections(plan, tx as never);
      assert.equal((await tx.product.findUniqueOrThrow({ where: { id: standalone.id }, select: { weightKg: true } })).weightKg?.toString(), "1.2");
    });
  });

  it("re-running the same file changes nothing the second time", async () => {
    await inRollback(async (tx) => {
      const { sku, v } = await setup(tx);
      const rows: R[] = [
        { masterskucode: sku.empty, proposedweightkg: "0.25", proposedlengthcm: "10" },
        { masterskucode: sku.complete, proposedweightkg: "0.8", updatetype: "REPLACE" },
      ];
      await applyCorrections(await planCorrections(src(rows), tx as never), tx as never);
      const after1 = [await read(tx, v.empty.id), await read(tx, v.complete.id)];
      const again = await planCorrections(src(rows), tx as never);
      assert.equal(again.items.length, 0);
      assert.equal(again.unchanged.length, 2);
      assert.equal(again.errors.length, 0);
      assert.equal(await applyCorrections(again, tx as never), 0);
      assert.deepEqual([await read(tx, v.empty.id), await read(tx, v.complete.id)], after1);
    });
  });

  it("the shipped template (every proposed cell blank) plans zero changes and zero errors", async () => {
    await inRollback(async (tx) => {
      const plan = await planCorrections(readCorrectionCsv(join(import.meta.dirname, "../../../docs/measurement-corrections-template-2026-11-04.csv")), tx as never);
      assert.equal(plan.items.length, 0);
      assert.equal(plan.errors.length, 0);
      assert.ok(plan.skipped.length >= 36);
    });
  });

  it("reads a real CSV file: a filled row and a blank one; a file that is not a corrections file is refused", async () => {
    await inRollback(async (tx) => {
      const { sku, v } = await setup(tx);
      const file = join(tmpdir(), `corr-${uid()}.csv`);
      writeFileSync(file, `Master SKU Code,Product Name,Current Weight (kg),Proposed Weight (kg),Proposed Length (cm),Proposed Breadth (cm),Proposed Height (cm),Update Type\n${sku.empty},Empty,,0.25,10,8,5,FILL\n${sku.unlisted},Unlisted,,,,,,FILL\n`);
      const plan = await planCorrections(readCorrectionCsv(file), tx as never);
      assert.equal(plan.items.length, 1);
      assert.equal(plan.skipped.length, 1);
      await applyCorrections(plan, tx as never);
      assert.deepEqual(await read(tx, v.empty.id), ["0.25", "10", "8", "5"]);
      assert.deepEqual(await read(tx, v.unlisted.id), [null, null, null, null]);
      const wrong = join(tmpdir(), `wrong-${uid()}.csv`);
      writeFileSync(wrong, "Master SKU Code,Weight,Dimensions\nX,0.2,1x1x1\n");
      await assert.rejects(planCorrections(readCorrectionCsv(wrong), tx as never), /not a measurement-corrections file/);
    });
  });
});
