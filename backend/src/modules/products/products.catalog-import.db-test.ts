// Shiprocket catalog import against the real schema. Each test runs in one transaction that is always rolled back.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma } from "../../lib/prisma.js";
import { ProductType } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { headerKey } from "./products.catalog-parse.js";
import { importCatalogRows, readCatalogCsv, NotACatalogError, type FailedRow } from "./products.catalog-import.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID().slice(0, 8);
type R = { sku?: string; master?: string; channelSku?: string; weight?: string; dims?: string; name?: string };
const rows = (list: R[]) =>
  (async function* () {
    for (const r of list) {
      yield Object.fromEntries(Object.entries({ "*SKU Code": r.sku ?? "", "Master SKU Code": r.master ?? "", "Channel SKU Code": r.channelSku ?? "", Weight: r.weight ?? "", Dimensions: r.dims ?? "", "Product Name": r.name ?? "" }).map(([k, v]) => [headerKey(k), v]));
    }
  })();

async function shopifyProduct(tx: Prisma.TransactionClient, sku: string) {
  const product = await tx.product.create({ data: { name: `Herbal ${sku}`, type: ProductType.PRODUCT, externalSource: "SHOPIFY", externalId: `p-${sku}` } });
  const variant = await tx.productVariant.create({ data: { productId: product.id, name: "60 pouches", sku, price: "349.00", externalSource: "SHOPIFY", externalId: `v-${sku}` } });
  return { product, variant };
}

describe("Shiprocket catalog import", () => {
  it("writes weight and structured dimensions to the variant matched by SKU and leaves its Shopify identity alone", async () => {
    await inRollback(async (tx) => {
      const sku = `AW-${uid()}`;
      const { variant } = await shopifyProduct(tx, sku);
      const s = await importCatalogRows(rows([{ sku, master: sku, weight: "0.250", dims: "20.000x15.000x2.000" }]), { db: tx });
      assert.deepEqual([s.total, s.imported, s.updated, s.unchanged, s.skipped, s.unmatched, s.errors], [1, 1, 0, 0, 0, 0, 0]);
      const after = await tx.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
      assert.equal(after.weightKg?.toString(), "0.25");
      assert.deepEqual([after.lengthCm?.toString(), after.widthCm?.toString(), after.heightCm?.toString()], ["20", "15", "2"]);
      assert.deepEqual([after.externalSource, after.externalId, after.sku, after.name, after.price?.toString()], ["SHOPIFY", `v-${sku}`, sku, "60 pouches", "349"]);
    });
  });

  it("is idempotent: importing the same file twice creates nothing and the second run reports everything unchanged", async () => {
    await inRollback(async (tx) => {
      const a = `AW-${uid()}`;
      const b = `AW-${uid()}`;
      await shopifyProduct(tx, a);
      await shopifyProduct(tx, b);
      const file: R[] = [{ sku: a, weight: "0.12", dims: "20x15x2" }, { sku: b, weight: "0.25", dims: "20x15x2" }];
      const [products0, variants0] = [await tx.product.count(), await tx.productVariant.count()];
      const first = await importCatalogRows(rows(file), { db: tx });
      const second = await importCatalogRows(rows(file), { db: tx });
      assert.equal(first.imported, 2);
      assert.deepEqual([second.unchanged, second.imported, second.updated], [2, 0, 0]);
      assert.deepEqual([await tx.product.count(), await tx.productVariant.count()], [products0, variants0]);
    });
  });

  it("reports a changed weight as updated, and never clears a recorded value when the catalog has 0 / blank", async () => {
    await inRollback(async (tx) => {
      const sku = `AW-${uid()}`;
      const { variant } = await shopifyProduct(tx, sku);
      await importCatalogRows(rows([{ sku, weight: "0.12", dims: "20x15x2" }]), { db: tx });
      const changed = await importCatalogRows(rows([{ sku, weight: "0.30" }]), { db: tx });
      assert.equal(changed.updated, 1);
      const zero = await importCatalogRows(rows([{ sku, weight: "0.000", dims: "0.000x0.000x0.000" }]), { db: tx });
      assert.equal(zero.skipped, 1);
      const v = await tx.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
      assert.equal(v.weightKg?.toString(), "0.3");
      assert.equal(v.lengthCm?.toString(), "20");
    });
  });

  it("matches by Master SKU Code first, then SKU Code, then the CRM's own SKU - never by product name", async () => {
    await inRollback(async (tx) => {
      const masterSku = `M-${uid()}`;
      const otherSku = `O-${uid()}`;
      const { variant: viaMaster } = await shopifyProduct(tx, masterSku);
      const { variant: viaOther } = await shopifyProduct(tx, otherSku);
      await importCatalogRows(rows([{ master: masterSku, sku: otherSku, weight: "0.4" }]), { db: tx });
      assert.equal((await tx.productVariant.findUniqueOrThrow({ where: { id: viaMaster.id } })).weightKg?.toString(), "0.4");
      assert.equal((await tx.productVariant.findUniqueOrThrow({ where: { id: viaOther.id } })).weightKg, null);
      // Same name as an existing product, but a SKU the CRM does not have: unmatched, not matched by name.
      const s = await importCatalogRows(rows([{ sku: `NOPE-${uid()}`, name: `Herbal ${masterSku}`, weight: "0.9" }]), { db: tx });
      assert.equal(s.unmatched, 1);
    });
  });

  it("falls back to a product's own SKU when no variant carries it", async () => {
    await inRollback(async (tx) => {
      const sku = `PS-${uid()}`;
      const product = await tx.product.create({ data: { name: `Solo ${sku}`, type: ProductType.PRODUCT, sku } });
      await importCatalogRows(rows([{ sku, weight: "0.5", dims: "25x20x3" }]), { db: tx });
      const p = await tx.product.findUniqueOrThrow({ where: { id: product.id } });
      assert.deepEqual([p.weightKg?.toString(), p.lengthCm?.toString(), p.heightCm?.toString()], ["0.5", "25", "3"]);
    });
  });

  it("classifies every row: skipped / unmatched / errors with reasons, and the counts add up to the total", async () => {
    await inRollback(async (tx) => {
      const sku = `AW-${uid()}`;
      await shopifyProduct(tx, sku);
      const failed: FailedRow[] = [];
      const s = await importCatalogRows(
        rows([
          { sku, weight: "0.2" }, // imported
          { sku, weight: "0.9" }, // duplicate in file
          { sku: `GHOST-${uid()}`, weight: "0.2" }, // unmatched
          { sku: `Z-${uid()}`, weight: "0.000", dims: "0x0x0" }, // nothing to import
          { sku: "8.00994E+12", weight: "0.2" }, // corrupted code
          { sku: `W-${uid()}`, weight: "200.000" }, // grams typed as kg
          { sku: `D-${uid()}`, weight: "0.2", dims: "bad" }, // malformed dims
          { weight: "0.2" }, // no SKU
        ]),
        { db: tx, failedRows: failed },
      );
      assert.deepEqual([s.total, s.imported, s.skipped, s.unmatched, s.errors], [8, 1, 2, 1, 4]);
      assert.equal(s.imported + s.updated + s.unchanged + s.skipped + s.unmatched + s.errors, s.total);
      assert.equal(failed.length, 7);
      assert.ok(failed.find((f) => f.status === "error" && /scientific notation/.test(f.reason)));
      assert.ok(failed.every((f) => f.row >= 2));
    });
  });

  it("processes in batches and reports progress after each one", async () => {
    await inRollback(async (tx) => {
      const skus = Array.from({ length: 7 }, () => `AW-${uid()}`);
      for (const sku of skus) await shopifyProduct(tx, sku);
      const seen: number[] = [];
      const s = await importCatalogRows(rows(skus.map((sku) => ({ sku, weight: "0.1" }))), { db: tx, batchSize: 3, onProgress: (n) => seen.push(n) });
      assert.equal(s.imported, 7);
      assert.deepEqual(seen, [3, 6, 7]);
    });
  });

  it("handles a catalog far beyond the old limits without loading it into memory: a 25,000-row file streams through", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "catalog-test-"));
    try {
      const file = path.join(dir, "big.csv");
      const lines = ['"*Channel Name","Product Name","*SKU Code",Weight,Dimensions,"Channel Product id","Master SKU Code"'];
      for (let i = 0; i < 25_000; i++) lines.push(`"Shop","Item ${i}",BIG-${i},0.2,20.000x15.000x2.000,8.00994E+12,BIG-${i}`);
      await writeFile(file, "﻿" + lines.join("\n"));
      let n = 0;
      let first: Record<string, string> | undefined;
      for await (const r of readCatalogCsv(file)) { n++; first ??= r; }
      assert.equal(n, 25_000);
      // IDs and SKUs come through as the exact strings in the file, never floats.
      assert.equal(first!.channelproductid, "8.00994E+12");
      assert.equal(first!.masterskucode, "BIG-0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a file that is not a catalog export before importing anything", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "catalog-test-"));
    try {
      const file = path.join(dir, "leads.csv");
      await writeFile(file, "name,phone\nA,123\n");
      await assert.rejects(async () => { for await (const _ of readCatalogCsv(file)) { /* drain */ } }, NotACatalogError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("imports the real Shiprocket export shape end to end from a CSV file", async () => {
    await inRollback(async (tx) => {
      const sku = `AW-${uid()}`;
      const { variant } = await shopifyProduct(tx, sku);
      const dir = await mkdtemp(path.join(os.tmpdir(), "catalog-test-"));
      try {
        const file = path.join(dir, "export.csv");
        await writeFile(file, `﻿"*Channel Name","Product Name","*SKU Code",Weight,Dimensions,Category,"Channel Product id","Channel SKU Code","Master SKU Code"\n"Aayush Wellness (Shopify)","Herbal Masala - Gutka Flavour / 120 - Pouches",${sku},0.250,20.000x15.000x2.000,"Herbal Masala",8009941287101,${sku},${sku}\n`);
        const s = await importCatalogRows(readCatalogCsv(file), { db: tx });
        assert.equal(s.imported, 1);
        const v = await tx.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
        assert.equal(v.weightKg?.toString(), "0.25");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
