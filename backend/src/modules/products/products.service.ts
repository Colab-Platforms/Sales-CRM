import { prisma } from "@/lib/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { DbClient } from "@/lib/leadScope.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { ListProductsQuery, ProductListResult } from "./products.types.js";

/** Per-unit dimensions only when all three sides are recorded. */
export const dims = (r: { lengthCm: { toString(): string } | null; widthCm: { toString(): string } | null; heightCm: { toString(): string } | null }) =>
  r.lengthCm && r.widthCm && r.heightCm ? { lengthCm: r.lengthCm.toString(), widthCm: r.widthCm.toString(), heightCm: r.heightCm.toString() } : null;

class ProductsService {
  constructor(private readonly db: DbClient = prisma) {}

  async listProducts(query: ListProductsQuery): Promise<ProductListResult> {
    const where: Prisma.ProductWhereInput = { status: "ACTIVE" };
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: "insensitive" } },
        { sku: { contains: query.search, mode: "insensitive" } },
      ];
    }

    const [totalItems, rows] = await Promise.all([
      this.db.product.count({ where }),
      this.db.product.findMany({
        where,
        select: {
          id: true,
          name: true,
          sku: true,
          basePrice: true,
          weightKg: true,
          lengthCm: true,
          widthCm: true,
          heightCm: true,
          variants: { where: { status: "ACTIVE" }, select: { id: true, name: true, sku: true, price: true, weightKg: true, lengthCm: true, widthCm: true, heightCm: true } },
        },
        orderBy: { name: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items: rows.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        basePrice: p.basePrice?.toString() ?? null,
        weightKg: p.weightKg?.toString() ?? null,
        dimensionsCm: dims(p),
        variants: p.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku, price: v.price?.toString() ?? null, weightKg: v.weightKg?.toString() ?? null, dimensionsCm: dims(v) })),
      })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }

  /**
   * Records the real weight of one unit (kg) of a product, or of one variant - or clears it (null). Only a person-entered value is ever stored:
   * nothing is defaulted or back-filled, and the Shopify catalog sync never touches this field.
   */
  async setWeight(target: { productId: string } | { variantId: string }, weightKg: number | null): Promise<{ weightKg: string | null }> {
    const data = { weightKg };
    if ("productId" in target) {
      const found = await this.db.product.findUnique({ where: { id: target.productId }, select: { id: true } });
      if (!found) throw new ApiError("Product not found", STATUS_CODES.NOT_FOUND);
      const row = await this.db.product.update({ where: { id: target.productId }, data, select: { weightKg: true } });
      return { weightKg: row.weightKg?.toString() ?? null };
    }
    const found = await this.db.productVariant.findUnique({ where: { id: target.variantId }, select: { id: true } });
    if (!found) throw new ApiError("Variant not found", STATUS_CODES.NOT_FOUND);
    const row = await this.db.productVariant.update({ where: { id: target.variantId }, data, select: { weightKg: true } });
    return { weightKg: row.weightKg?.toString() ?? null };
  }
}

export default ProductsService;
