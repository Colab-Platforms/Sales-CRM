import { prisma } from "@/lib/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { ListProductsQuery, ProductListResult } from "./products.types.js";

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
          variants: { where: { status: "ACTIVE" }, select: { id: true, name: true, sku: true, price: true } },
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
        variants: p.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku, price: v.price?.toString() ?? null })),
      })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }
}

export default ProductsService;
