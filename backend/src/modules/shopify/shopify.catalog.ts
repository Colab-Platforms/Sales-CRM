import { z } from "zod";
import type { ShopifyClient } from "./shopify.client.js";
import { parseOrFail } from "./shopify.orders.js";
import { CUSTOMER_BY_ID_QUERY, PRODUCT_BY_ID_QUERY } from "./shopify.queries.js";

// Shopify products/variants and customers: response shapes, normalization and fetchers (read-only).

const productNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  handle: z.string().nullish(),
  status: z.string().nullish(),
  vendor: z.string().nullish(),
  productType: z.string().nullish(),
  description: z.string().nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string(),
  variants: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        sku: z.string().nullish(),
        price: z.string().nullish(),
        updatedAt: z.string().nullish(),
      }),
    ),
  }),
});

const customerNodeSchema = z.object({
  id: z.string(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string(),
  defaultAddress: z
    .object({ city: z.string().nullish(), province: z.string().nullish(), zip: z.string().nullish() })
    .nullish(),
});

export interface NormalizedVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string | null;
  updatedAt: string | null;
}

export interface NormalizedProduct {
  id: string;
  title: string;
  handle: string | null;
  status: string | null;
  vendor: string | null;
  productType: string | null;
  description: string | null;
  updatedAt: string;
  variants: NormalizedVariant[];
  variantsTruncated: boolean;
}

export interface NormalizedShopifyCustomer {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  createdAt: string | null;
  updatedAt: string;
  city: string | null;
  province: string | null;
}

/** The full product, or null if Shopify no longer has it. */
export async function fetchProduct(client: ShopifyClient, gid: string): Promise<NormalizedProduct | null> {
  const data = parseOrFail(
    z.object({ product: productNodeSchema.nullable() }),
    await client.query<unknown>(PRODUCT_BY_ID_QUERY, { id: gid }),
    "the product",
  );
  const p = data.product;
  if (!p) return null;
  return {
    id: p.id,
    title: p.title,
    handle: p.handle ?? null,
    status: p.status ?? null,
    vendor: p.vendor ?? null,
    productType: p.productType ?? null,
    description: p.description ?? null,
    updatedAt: p.updatedAt,
    variants: p.variants.nodes.map((v) => ({
      id: v.id,
      title: v.title,
      sku: v.sku ?? null,
      price: v.price ?? null,
      updatedAt: v.updatedAt ?? null,
    })),
    variantsTruncated: p.variants.pageInfo.hasNextPage,
  };
}

/** The full customer, or null if Shopify no longer has it. */
export async function fetchCustomer(client: ShopifyClient, gid: string): Promise<NormalizedShopifyCustomer | null> {
  const data = parseOrFail(
    z.object({ customer: customerNodeSchema.nullable() }),
    await client.query<unknown>(CUSTOMER_BY_ID_QUERY, { id: gid }),
    "the customer",
  );
  const c = data.customer;
  if (!c) return null;
  return {
    id: c.id,
    firstName: c.firstName ?? null,
    lastName: c.lastName ?? null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    createdAt: c.createdAt ?? null,
    updatedAt: c.updatedAt,
    city: c.defaultAddress?.city ?? null,
    province: c.defaultAddress?.province ?? null,
  };
}
