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
