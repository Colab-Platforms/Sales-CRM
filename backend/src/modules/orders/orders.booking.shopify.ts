import { z } from "zod";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import { parseOrFail } from "../shopify/shopify.orders.js";

// E5 on-call booking: live, read-only Shopify catalog lookups.
// Price and availability always come from Shopify at request time, never from the browser.

let cachedClient: ShopifyClient | null = null;

export function getBookingShopifyClient(): ShopifyClient {
  if (cachedClient) return cachedClient;
  try {
    cachedClient = new ShopifyClient(loadShopifyConfig());
    return cachedClient;
  } catch {
    throw new ApiError("Shopify is not configured on this server", 503);
  }
}

const variantSchema = z.object({
  id: z.string(),
  title: z.string(),
  sku: z.string().nullish(),
  price: z.string(),
  availableForSale: z.boolean(),
  inventoryQuantity: z.number().int().nullish(),
  inventoryPolicy: z.string().nullish(),
});

const productSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  collections: z.object({ nodes: z.array(z.object({ id: z.string(), title: z.string() })) }),
  variants: z.object({ nodes: z.array(variantSchema) }),
});

const CATALOG_QUERY = `#graphql
  query E5BookingCatalog($query: String!) {
    products(first: 50, query: $query, sortKey: TITLE) {
      nodes {
        id
        title
        status
        collections(first: 10) { nodes { id title } }
        variants(first: 50) {
          nodes { id title sku price availableForSale inventoryQuantity inventoryPolicy }
        }
      }
    }
  }`;

const VARIANT_QUERY = `#graphql
  query E5BookingVariant($id: ID!) {
    productVariant(id: $id) {
      id
      title
      sku
      price
      availableForSale
      inventoryQuantity
      inventoryPolicy
      product { id title status }
    }
  }`;

export interface BookingVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  sellable: boolean;
  inventoryQuantity: number | null;
  tracksInventory: boolean;
}

export interface BookingProduct {
  id: string;
  title: string;
  sections: string[];
  variants: BookingVariant[];
}

export interface ResolvedVariant {
  variantGid: string;
  variantTitle: string;
  productGid: string;
  productTitle: string;
  sku: string | null;
  unitPrice: string;
}

function isSellable(productStatus: string, variant: z.infer<typeof variantSchema>): boolean {
  return productStatus === "ACTIVE" && variant.availableForSale;
}

/** Active products (optionally filtered by a search term) with their variants, for the order screen. */
export async function searchBookingCatalog(search?: string): Promise<BookingProduct[]> {
  const term = search?.trim().replace(/["'\\()]/g, "") ?? "";
  const query = term ? `status:active AND (${term})` : "status:active";

  const data = parseOrFail(
    z.object({ products: z.object({ nodes: z.array(productSchema) }) }),
    await getBookingShopifyClient().query<unknown>(CATALOG_QUERY, { query }),
    "the product catalog",
  );

  return data.products.nodes.map((p) => ({
    id: p.id,
    title: p.title,
    sections: p.collections.nodes.map((c) => c.title),
    variants: p.variants.nodes.map((v) => ({
      id: v.id,
      title: v.title,
      sku: v.sku ?? null,
      price: v.price,
      sellable: isSellable(p.status, v),
      inventoryQuantity: v.inventoryQuantity ?? null,
      tracksInventory: v.inventoryPolicy === "DENY",
    })),
  }));
}

/**
 * Re-reads one variant from Shopify at order time and rejects it if it can't be sold in this quantity.
 * This is the server-side source of truth for price and availability (US-5.3 / US-5.5).
 */
export async function resolveVariantForOrder(variantGid: string, quantity: number): Promise<ResolvedVariant> {
  const data = parseOrFail(
    z.object({
      productVariant: variantSchema
        .extend({ product: z.object({ id: z.string(), title: z.string(), status: z.string() }) })
        .nullable(),
    }),
    await getBookingShopifyClient().query<unknown>(VARIANT_QUERY, { id: variantGid }),
    "the product variant",
  );

  const v = data.productVariant;
  if (!v) {
    throw new ApiError("The selected product variant no longer exists in the store", STATUS_CODES.BAD_REQUEST);
  }
  const label = `${v.product.title} (${v.title})`;
  if (!isSellable(v.product.status, v)) {
    throw new ApiError(`${label} is not available for sale`, STATUS_CODES.BAD_REQUEST);
  }
  if (v.inventoryPolicy === "DENY" && v.inventoryQuantity != null && quantity > v.inventoryQuantity) {
    throw new ApiError(`Only ${v.inventoryQuantity} of ${label} in stock`, STATUS_CODES.BAD_REQUEST);
  }

  return {
    variantGid: v.id,
    variantTitle: v.title,
    productGid: v.product.id,
    productTitle: v.product.title,
    sku: v.sku ?? null,
    unitPrice: v.price,
  };
}