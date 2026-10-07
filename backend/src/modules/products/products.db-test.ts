// Database integration tests for the minimal read-only product listing (added for E7.8's manual
// "Create Order" product picker). Run with: npm run test:db
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductStatus, ProductType } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import ProductsService from "./products.service.js";

class Rollback extends Error {}

async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

after(() => prisma.$disconnect());

const uid = () => randomUUID();

describe("listProducts", () => {
  it("returns an active product with its active variants", async () => {
    await inRollback(async (tx) => {
      const product = await tx.product.create({ data: { name: `Herbal Tea ${uid()}`, type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "349.00" } });
      await tx.productVariant.create({ data: { productId: product.id, name: "100g", price: "349.00" } });
      const svc = new ProductsService(tx);

      const result = await svc.listProducts({ page: 1, pageSize: 20, search: product.name });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]!.id, product.id);
      assert.equal(result.items[0]!.variants.length, 1);
      assert.equal(result.items[0]!.variants[0]!.name, "100g");
    });
  });

  it("excludes an inactive product", async () => {
    await inRollback(async (tx) => {
      const product = await tx.product.create({ data: { name: `Discontinued ${uid()}`, type: ProductType.PRODUCT, status: ProductStatus.INACTIVE } });
      const svc = new ProductsService(tx);
      const result = await svc.listProducts({ page: 1, pageSize: 20, search: product.name });
      assert.equal(result.items.length, 0);
    });
  });

  it("searches by name or SKU", async () => {
    await inRollback(async (tx) => {
      const sku = `UNIQUESKU-${uid()}`;
      const product = await tx.product.create({ data: { name: "Generic Name", type: ProductType.PRODUCT, sku } });
      const svc = new ProductsService(tx);
      const result = await svc.listProducts({ page: 1, pageSize: 20, search: sku });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]!.id, product.id);
    });
  });
});

describe("product / SKU weight (informational, never guessed)", () => {
  it("a product and variant with no recorded weight list as null - nothing is defaulted", async () => {
    await inRollback(async (tx) => {
      const product = await tx.product.create({ data: { name: `Weightless ${uid()}`, type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "100.00" } });
      await tx.productVariant.create({ data: { productId: product.id, name: "Pack Of 1", price: "100.00" } });
      const r = await new ProductsService(tx).listProducts({ page: 1, pageSize: 20, search: product.name });
      assert.equal(r.items[0]!.weightKg, null);
      assert.equal(r.items[0]!.variants[0]!.weightKg, null);
    });
  });

  it("a person can record a variant's real weight (pack sizes differ), change it, and clear it again; the list shows exactly what was stored", async () => {
    await inRollback(async (tx) => {
      const product = await tx.product.create({ data: { name: `Brain Fuel ${uid()}`, type: ProductType.PRODUCT, sku: `SKU-${uid()}` } });
      const one = await tx.productVariant.create({ data: { productId: product.id, name: "Pack Of 1", sku: `V1-${uid()}` } });
      const three = await tx.productVariant.create({ data: { productId: product.id, name: "Pack Of 3", sku: `V3-${uid()}` } });
      const svc = new ProductsService(tx);
      assert.deepEqual(await svc.setWeight({ variantId: one.id }, 0.25), { weightKg: "0.25" });
      assert.deepEqual(await svc.setWeight({ variantId: three.id }, 0.75), { weightKg: "0.75" });
      const r = await svc.listProducts({ page: 1, pageSize: 20, search: product.name });
      const by = Object.fromEntries(r.items[0]!.variants.map((v) => [v.name, v.weightKg]));
      assert.deepEqual(by, { "Pack Of 1": "0.25", "Pack Of 3": "0.75" });
      assert.equal(r.items[0]!.weightKg, null, "the product itself stays unrecorded");
      assert.deepEqual(await svc.setWeight({ variantId: one.id }, null), { weightKg: null });
    });
  });

  it("a variant-less product can carry its own weight; unknown ids are 404", async () => {
    await inRollback(async (tx) => {
      const product = await tx.product.create({ data: { name: `Single ${uid()}`, type: ProductType.PRODUCT } });
      const svc = new ProductsService(tx);
      assert.deepEqual(await svc.setWeight({ productId: product.id }, 1.5), { weightKg: "1.5" });
      await assert.rejects(() => svc.setWeight({ productId: uid() }, 1), (e: any) => e.statusCode === 404);
      await assert.rejects(() => svc.setWeight({ variantId: uid() }, 1), (e: any) => e.statusCode === 404);
    });
  });

  it("0, negative and non-numeric weights are rejected; null (clear) is allowed", async () => {
    const { validateWeightBody } = await import("./products.validators.js");
    assert.ok(validateWeightBody({ weightKg: 0 }).error);
    assert.ok(validateWeightBody({ weightKg: -0.5 }).error);
    assert.ok(validateWeightBody({ weightKg: "abc" }).error);
    assert.ok(validateWeightBody({ weightKg: 101 }).error);
    assert.equal(validateWeightBody({ weightKg: null }).value?.weightKg, null);
    assert.equal(validateWeightBody({ weightKg: "0.25" }).value?.weightKg, 0.25);
  });
});
